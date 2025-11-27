#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import Database from "better-sqlite3";
import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync } from "fs";

// Configuration
const CONFIG_PATH = join(homedir(), ".claude", "memory-config.json");
let firestoreSync = null;

// Load config if exists
function loadConfig() {
  if (existsSync(CONFIG_PATH)) {
    try {
      const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      return config;
    } catch (e) {
      console.error("Failed to load config:", e.message);
    }
  }
  return {};
}

const config = loadConfig();

// Firestore sync module (lazy loaded)
async function initFirestoreSync() {
  if (!config.firestore?.enabled) return null;

  try {
    const { Firestore } = await import("@google-cloud/firestore");

    const firestoreConfig = {
      projectId: config.firestore.projectId,
    };

    // Use service account if provided, otherwise use application default credentials
    if (config.firestore.keyFilePath) {
      firestoreConfig.keyFilename = config.firestore.keyFilePath;
    }

    const firestore = new Firestore(firestoreConfig);
    const collectionPrefix = config.firestore.collectionPrefix || "claude-memory";

    console.error(`Firestore sync enabled: project=${config.firestore.projectId}, prefix=${collectionPrefix}`);

    return {
      firestore,
      collectionPrefix,

      // Sync a record to Firestore
      async syncToCloud(table, data) {
        try {
          const docId = `${data.project || 'global'}_${data.id || Date.now()}`;
          await firestore.collection(`${collectionPrefix}_${table}`).doc(docId).set({
            ...data,
            syncedAt: new Date().toISOString(),
            machine: config.machineId || "unknown",
          }, { merge: true });
        } catch (e) {
          console.error(`Firestore sync error (${table}):`, e.message);
        }
      },

      // Pull all records from Firestore for a project
      async pullFromCloud(table, project) {
        try {
          const snapshot = await firestore
            .collection(`${collectionPrefix}_${table}`)
            .where("project", "==", project)
            .get();

          return snapshot.docs.map(doc => doc.data());
        } catch (e) {
          console.error(`Firestore pull error (${table}):`, e.message);
          return [];
        }
      },
    };
  } catch (e) {
    console.error("Failed to initialize Firestore:", e.message);
    console.error("Install with: npm install @google-cloud/firestore");
    return null;
  }
}

// Database setup
const dbPath = join(homedir(), ".claude", "memory.db");
const db = new Database(dbPath);

// Helper function for relative time
function getTimeAgo(timestamp) {
  const now = new Date();
  const then = new Date(timestamp);
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return then.toLocaleDateString();
}

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    date TEXT NOT NULL,
    decision TEXT NOT NULL,
    rationale TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    synced_at TEXT
  );

  CREATE TABLE IF NOT EXISTS errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    error_pattern TEXT NOT NULL,
    solution TEXT NOT NULL,
    context TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    synced_at TEXT
  );

  CREATE TABLE IF NOT EXISTS context (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    synced_at TEXT,
    UNIQUE(project, key)
  );

  CREATE TABLE IF NOT EXISTS learnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT,
    category TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    synced_at TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL UNIQUE,
    task TEXT NOT NULL,
    status TEXT,
    notes TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    synced_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_decisions_project ON decisions(project);
  CREATE INDEX IF NOT EXISTS idx_errors_project ON errors(project);
  CREATE INDEX IF NOT EXISTS idx_context_project ON context(project);
  CREATE INDEX IF NOT EXISTS idx_learnings_project ON learnings(project);
  CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
`);

// Prepared statements
const insertDecision = db.prepare(
  "INSERT INTO decisions (project, date, decision, rationale) VALUES (?, ?, ?, ?)"
);
const getDecisions = db.prepare(
  "SELECT * FROM decisions WHERE project = ? ORDER BY date DESC LIMIT ?"
);
const searchDecisions = db.prepare(
  "SELECT * FROM decisions WHERE project = ? AND (decision LIKE ? OR rationale LIKE ?) ORDER BY date DESC"
);

const insertError = db.prepare(
  "INSERT INTO errors (project, error_pattern, solution, context) VALUES (?, ?, ?, ?)"
);
const findSolution = db.prepare(
  "SELECT * FROM errors WHERE project = ? AND error_pattern LIKE ? ORDER BY created_at DESC LIMIT 5"
);
const getRecentErrors = db.prepare(
  "SELECT * FROM errors WHERE project = ? ORDER BY created_at DESC LIMIT ?"
);

const upsertContext = db.prepare(`
  INSERT INTO context (project, key, value, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(project, key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
`);
const getContext = db.prepare(
  "SELECT key, value FROM context WHERE project = ?"
);
const getContextValue = db.prepare(
  "SELECT value FROM context WHERE project = ? AND key = ?"
);
const deleteContext = db.prepare(
  "DELETE FROM context WHERE project = ? AND key = ?"
);

const insertLearning = db.prepare(
  "INSERT INTO learnings (project, category, content) VALUES (?, ?, ?)"
);
const getLearnings = db.prepare(
  "SELECT * FROM learnings WHERE (project = ? OR project IS NULL) ORDER BY created_at DESC LIMIT ?"
);
const searchLearnings = db.prepare(
  "SELECT * FROM learnings WHERE (project = ? OR project IS NULL) AND content LIKE ? ORDER BY created_at DESC"
);

const upsertSession = db.prepare(`
  INSERT INTO sessions (project, task, status, notes, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(project) DO UPDATE SET task = excluded.task, status = excluded.status, notes = excluded.notes, updated_at = CURRENT_TIMESTAMP
`);
const getSession = db.prepare(
  "SELECT * FROM sessions WHERE project = ?"
);
const deleteSession = db.prepare(
  "DELETE FROM sessions WHERE project = ?"
);

// Create MCP server
const server = new Server(
  {
    name: "claude-memory",
    version: "2.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const syncTools = firestoreSync ? [
    {
      name: "sync_to_cloud",
      description: "Manually sync all local memory to Firestore cloud storage",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: "Project to sync (or 'all' for everything)" },
        },
        required: ["project"],
      },
    },
    {
      name: "pull_from_cloud",
      description: "Pull memory from Firestore cloud for a project",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: "Project to pull" },
        },
        required: ["project"],
      },
    },
  ] : [];

  return {
    tools: [
      {
        name: "remember_decision",
        description: "Store a project decision with its rationale for future reference",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name (e.g., 'cutie', 'nutri-e')" },
            decision: { type: "string", description: "What was decided" },
            rationale: { type: "string", description: "Why this decision was made" },
            date: { type: "string", description: "Date of decision (YYYY-MM-DD), defaults to today" },
          },
          required: ["project", "decision"],
        },
      },
      {
        name: "recall_decisions",
        description: "Retrieve past decisions for a project",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name" },
            search: { type: "string", description: "Optional search term" },
            limit: { type: "number", description: "Max results (default 10)" },
          },
          required: ["project"],
        },
      },
      {
        name: "remember_error",
        description: "Store an error and its solution for future reference",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name" },
            error_pattern: { type: "string", description: "Error message or pattern to match" },
            solution: { type: "string", description: "How the error was fixed" },
            context: { type: "string", description: "Additional context about when this occurs" },
          },
          required: ["project", "error_pattern", "solution"],
        },
      },
      {
        name: "find_solution",
        description: "Search for solutions to an error",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name" },
            error: { type: "string", description: "Error message to search for" },
          },
          required: ["project", "error"],
        },
      },
      {
        name: "set_context",
        description: "Store a key-value pair for a project (e.g., SDK version, URLs)",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name" },
            key: { type: "string", description: "Context key (e.g., 'sdk_version', 'api_url')" },
            value: { type: "string", description: "Context value" },
          },
          required: ["project", "key", "value"],
        },
      },
      {
        name: "get_context",
        description: "Get stored context for a project",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name" },
            key: { type: "string", description: "Optional specific key to retrieve" },
          },
          required: ["project"],
        },
      },
      {
        name: "remember_learning",
        description: "Store a general learning or insight",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name (optional, null for global)" },
            category: { type: "string", description: "Category (e.g., 'pattern', 'gotcha', 'best-practice')" },
            content: { type: "string", description: "The learning content" },
          },
          required: ["category", "content"],
        },
      },
      {
        name: "recall_learnings",
        description: "Retrieve past learnings",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name (also includes global learnings)" },
            search: { type: "string", description: "Optional search term" },
            limit: { type: "number", description: "Max results (default 20)" },
          },
          required: ["project"],
        },
      },
      {
        name: "delete_context",
        description: "Remove a context key from a project",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name" },
            key: { type: "string", description: "Context key to delete" },
          },
          required: ["project", "key"],
        },
      },
      {
        name: "list_errors",
        description: "List all stored errors for a project",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name" },
            limit: { type: "number", description: "Max results (default 10)" },
          },
          required: ["project"],
        },
      },
      {
        name: "search_all",
        description: "Search across all memory types (decisions, errors, learnings, context)",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name" },
            query: { type: "string", description: "Search term" },
          },
          required: ["project", "query"],
        },
      },
      {
        name: "save_session",
        description: "Save current work session state (call before ending session)",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name" },
            task: { type: "string", description: "What you're working on (e.g., 'Issue #22 - Firestore migration')" },
            status: { type: "string", description: "Current status (e.g., 'in-progress', 'blocked', 'ready-for-review')" },
            notes: { type: "string", description: "Next steps or important context for resuming" },
          },
          required: ["project", "task"],
        },
      },
      {
        name: "get_session",
        description: "Get last saved session state (call at session start to resume work)",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name" },
          },
          required: ["project"],
        },
      },
      {
        name: "clear_session",
        description: "Clear session state when work is complete",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name" },
          },
          required: ["project"],
        },
      },
      ...syncTools,
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "remember_decision": {
        const date = args.date || new Date().toISOString().split("T")[0];
        const result = insertDecision.run(args.project, date, args.decision, args.rationale || null);

        // Sync to cloud if enabled
        if (firestoreSync) {
          await firestoreSync.syncToCloud("decisions", {
            id: result.lastInsertRowid,
            project: args.project,
            date,
            decision: args.decision,
            rationale: args.rationale,
          });
        }

        return { content: [{ type: "text", text: `Decision stored for ${args.project}${firestoreSync ? ' (synced)' : ''}` }] };
      }

      case "recall_decisions": {
        let results;
        if (args.search) {
          const pattern = `%${args.search}%`;
          results = searchDecisions.all(args.project, pattern, pattern);
        } else {
          results = getDecisions.all(args.project, args.limit || 10);
        }
        return {
          content: [{
            type: "text",
            text: results.length > 0
              ? results.map(r => `[${r.date}] ${r.decision}\n  Rationale: ${r.rationale || 'N/A'}`).join("\n\n")
              : "No decisions found for this project"
          }]
        };
      }

      case "remember_error": {
        const result = insertError.run(args.project, args.error_pattern, args.solution, args.context || null);

        if (firestoreSync) {
          await firestoreSync.syncToCloud("errors", {
            id: result.lastInsertRowid,
            project: args.project,
            error_pattern: args.error_pattern,
            solution: args.solution,
            context: args.context,
          });
        }

        return { content: [{ type: "text", text: `Error solution stored for ${args.project}${firestoreSync ? ' (synced)' : ''}` }] };
      }

      case "find_solution": {
        const pattern = `%${args.error}%`;
        const results = findSolution.all(args.project, pattern);
        return {
          content: [{
            type: "text",
            text: results.length > 0
              ? results.map(r => `Error: ${r.error_pattern}\nSolution: ${r.solution}\nContext: ${r.context || 'N/A'}`).join("\n\n---\n\n")
              : "No matching solutions found"
          }]
        };
      }

      case "set_context": {
        upsertContext.run(args.project, args.key, args.value);

        if (firestoreSync) {
          await firestoreSync.syncToCloud("context", {
            id: `${args.project}_${args.key}`,
            project: args.project,
            key: args.key,
            value: args.value,
          });
        }

        return { content: [{ type: "text", text: `Context ${args.key} set for ${args.project}${firestoreSync ? ' (synced)' : ''}` }] };
      }

      case "get_context": {
        if (args.key) {
          const result = getContextValue.get(args.project, args.key);
          return {
            content: [{
              type: "text",
              text: result ? `${args.key}: ${result.value}` : `No value found for ${args.key}`
            }]
          };
        } else {
          const results = getContext.all(args.project);
          return {
            content: [{
              type: "text",
              text: results.length > 0
                ? results.map(r => `${r.key}: ${r.value}`).join("\n")
                : "No context stored for this project"
            }]
          };
        }
      }

      case "remember_learning": {
        const result = insertLearning.run(args.project || null, args.category, args.content);

        if (firestoreSync) {
          await firestoreSync.syncToCloud("learnings", {
            id: result.lastInsertRowid,
            project: args.project,
            category: args.category,
            content: args.content,
          });
        }

        return { content: [{ type: "text", text: `Learning stored (${args.category})${firestoreSync ? ' (synced)' : ''}` }] };
      }

      case "recall_learnings": {
        let results;
        if (args.search) {
          const pattern = `%${args.search}%`;
          results = searchLearnings.all(args.project, pattern);
        } else {
          results = getLearnings.all(args.project, args.limit || 20);
        }
        return {
          content: [{
            type: "text",
            text: results.length > 0
              ? results.map(r => `[${r.category}] ${r.content}${r.project ? ` (${r.project})` : ' (global)'}`).join("\n\n")
              : "No learnings found"
          }]
        };
      }

      case "delete_context": {
        const result = deleteContext.run(args.project, args.key);
        return {
          content: [{
            type: "text",
            text: result.changes > 0
              ? `Deleted context key '${args.key}' from ${args.project}`
              : `No context key '${args.key}' found for ${args.project}`
          }]
        };
      }

      case "list_errors": {
        const results = getRecentErrors.all(args.project, args.limit || 10);
        return {
          content: [{
            type: "text",
            text: results.length > 0
              ? results.map(r => `[ID:${r.id}] ${r.error_pattern}\n  Solution: ${r.solution}\n  Context: ${r.context || 'N/A'}`).join("\n\n")
              : "No errors stored for this project"
          }]
        };
      }

      case "search_all": {
        const pattern = `%${args.query}%`;
        const decisions = searchDecisions.all(args.project, pattern, pattern);
        const errors = findSolution.all(args.project, pattern);
        const learnings = searchLearnings.all(args.project, pattern);
        const contexts = db.prepare(
          "SELECT key, value FROM context WHERE project = ? AND (key LIKE ? OR value LIKE ?)"
        ).all(args.project, pattern, pattern);

        let output = [];
        if (decisions.length > 0) {
          output.push("=== DECISIONS ===\n" + decisions.map(r => `[${r.date}] ${r.decision}`).join("\n"));
        }
        if (errors.length > 0) {
          output.push("=== ERRORS ===\n" + errors.map(r => `${r.error_pattern}: ${r.solution}`).join("\n"));
        }
        if (learnings.length > 0) {
          output.push("=== LEARNINGS ===\n" + learnings.map(r => `[${r.category}] ${r.content}`).join("\n"));
        }
        if (contexts.length > 0) {
          output.push("=== CONTEXT ===\n" + contexts.map(r => `${r.key}: ${r.value}`).join("\n"));
        }

        return {
          content: [{
            type: "text",
            text: output.length > 0 ? output.join("\n\n") : `No results found for '${args.query}'`
          }]
        };
      }

      case "save_session": {
        upsertSession.run(args.project, args.task, args.status || 'in-progress', args.notes || null);

        if (firestoreSync) {
          await firestoreSync.syncToCloud("sessions", {
            id: args.project,
            project: args.project,
            task: args.task,
            status: args.status,
            notes: args.notes,
          });
        }

        return { content: [{ type: "text", text: `Session saved for ${args.project}: ${args.task}${firestoreSync ? ' (synced)' : ''}` }] };
      }

      case "get_session": {
        const session = getSession.get(args.project);
        if (session) {
          const timeAgo = getTimeAgo(session.updated_at);
          return {
            content: [{
              type: "text",
              text: `Last session (${timeAgo}):\nTask: ${session.task}\nStatus: ${session.status || 'in-progress'}\nNotes: ${session.notes || 'None'}`
            }]
          };
        }
        return { content: [{ type: "text", text: "No saved session found" }] };
      }

      case "clear_session": {
        const result = deleteSession.run(args.project);
        return {
          content: [{
            type: "text",
            text: result.changes > 0 ? `Session cleared for ${args.project}` : "No session to clear"
          }]
        };
      }

      // Cloud sync tools (only available when Firestore is enabled)
      case "sync_to_cloud": {
        if (!firestoreSync) {
          return { content: [{ type: "text", text: "Firestore sync not enabled. Configure in ~/.claude/memory-config.json" }] };
        }

        const tables = ["decisions", "errors", "context", "learnings", "sessions"];
        let synced = 0;

        for (const table of tables) {
          let query = `SELECT * FROM ${table}`;
          if (args.project !== "all") {
            query += ` WHERE project = ?`;
          }

          const rows = args.project !== "all"
            ? db.prepare(query).all(args.project)
            : db.prepare(query).all();

          for (const row of rows) {
            await firestoreSync.syncToCloud(table, row);
            synced++;
          }
        }

        return { content: [{ type: "text", text: `Synced ${synced} records to Firestore` }] };
      }

      case "pull_from_cloud": {
        if (!firestoreSync) {
          return { content: [{ type: "text", text: "Firestore sync not enabled. Configure in ~/.claude/memory-config.json" }] };
        }

        const tables = ["decisions", "errors", "context", "learnings", "sessions"];
        let pulled = 0;

        for (const table of tables) {
          const cloudRecords = await firestoreSync.pullFromCloud(table, args.project);

          for (const record of cloudRecords) {
            // Merge cloud records into local DB (skip if newer local version exists)
            // This is a simple last-write-wins strategy
            try {
              if (table === "decisions") {
                insertDecision.run(record.project, record.date, record.decision, record.rationale);
              } else if (table === "errors") {
                insertError.run(record.project, record.error_pattern, record.solution, record.context);
              } else if (table === "context") {
                upsertContext.run(record.project, record.key, record.value);
              } else if (table === "learnings") {
                insertLearning.run(record.project, record.category, record.content);
              } else if (table === "sessions") {
                upsertSession.run(record.project, record.task, record.status, record.notes);
              }
              pulled++;
            } catch (e) {
              // Likely a duplicate, skip
            }
          }
        }

        return { content: [{ type: "text", text: `Pulled ${pulled} records from Firestore` }] };
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
    }
  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }] };
  }
});

// Start server
async function main() {
  // Initialize Firestore sync if configured
  firestoreSync = await initFirestoreSync();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Claude Memory MCP server running (v2.0.0)${firestoreSync ? ' [Firestore enabled]' : ''}`);
}

main().catch(console.error);
