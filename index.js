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
    synced_at TEXT,
    archived INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    error_pattern TEXT NOT NULL,
    solution TEXT NOT NULL,
    context TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    synced_at TEXT,
    archived INTEGER DEFAULT 0
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
    synced_at TEXT,
    archived INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    workspace TEXT,
    task TEXT NOT NULL,
    status TEXT,
    notes TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    synced_at TEXT,
    UNIQUE(project, workspace)
  );

  CREATE INDEX IF NOT EXISTS idx_decisions_project ON decisions(project);
  CREATE INDEX IF NOT EXISTS idx_errors_project ON errors(project);
  CREATE INDEX IF NOT EXISTS idx_context_project ON context(project);
  CREATE INDEX IF NOT EXISTS idx_learnings_project ON learnings(project);
  CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
`);

// Add archived column to existing tables if missing (migration)
try {
  db.exec(`ALTER TABLE decisions ADD COLUMN archived INTEGER DEFAULT 0`);
} catch (e) { /* column already exists */ }
try {
  db.exec(`ALTER TABLE errors ADD COLUMN archived INTEGER DEFAULT 0`);
} catch (e) { /* column already exists */ }
try {
  db.exec(`ALTER TABLE learnings ADD COLUMN archived INTEGER DEFAULT 0`);
} catch (e) { /* column already exists */ }

// Add priority column to decisions, errors, learnings (migration v2.5.0)
// Priority: 0 = normal (default), 1 = high, 2 = critical
try {
  db.exec(`ALTER TABLE decisions ADD COLUMN priority INTEGER DEFAULT 0`);
} catch (e) { /* column already exists */ }
try {
  db.exec(`ALTER TABLE errors ADD COLUMN priority INTEGER DEFAULT 0`);
} catch (e) { /* column already exists */ }
try {
  db.exec(`ALTER TABLE learnings ADD COLUMN priority INTEGER DEFAULT 0`);
} catch (e) { /* column already exists */ }

// Add category column to decisions and errors (migration v2.6.0)
// Categories help organize and filter memory items
try {
  db.exec(`ALTER TABLE decisions ADD COLUMN category TEXT`);
} catch (e) { /* column already exists */ }
try {
  db.exec(`ALTER TABLE errors ADD COLUMN category TEXT`);
} catch (e) { /* column already exists */ }

// Add usage tracking for memory tiers (migration v2.7.0)
// Tracks access patterns to identify hot/warm/cold memory items
try {
  db.exec(`ALTER TABLE decisions ADD COLUMN access_count INTEGER DEFAULT 0`);
} catch (e) { /* column already exists */ }
try {
  db.exec(`ALTER TABLE decisions ADD COLUMN last_accessed TEXT`);
} catch (e) { /* column already exists */ }
try {
  db.exec(`ALTER TABLE errors ADD COLUMN access_count INTEGER DEFAULT 0`);
} catch (e) { /* column already exists */ }
try {
  db.exec(`ALTER TABLE errors ADD COLUMN last_accessed TEXT`);
} catch (e) { /* column already exists */ }
try {
  db.exec(`ALTER TABLE learnings ADD COLUMN access_count INTEGER DEFAULT 0`);
} catch (e) { /* column already exists */ }
try {
  db.exec(`ALTER TABLE learnings ADD COLUMN last_accessed TEXT`);
} catch (e) { /* column already exists */ }

// Migration for multi-workspace support: add workspace column and update unique constraint
try {
  // Check if workspace column exists
  const tableInfo = db.prepare("PRAGMA table_info(sessions)").all();
  const hasWorkspace = tableInfo.some(col => col.name === 'workspace');

  if (!hasWorkspace) {
    // Need to recreate the table with the new schema
    db.exec(`
      -- Create new table with correct schema
      CREATE TABLE sessions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        workspace TEXT,
        task TEXT NOT NULL,
        status TEXT,
        notes TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        synced_at TEXT,
        UNIQUE(project, workspace)
      );

      -- Copy existing data (workspace will be NULL for existing sessions)
      INSERT INTO sessions_new (id, project, task, status, notes, updated_at, synced_at)
        SELECT id, project, task, status, notes, updated_at, synced_at FROM sessions;

      -- Drop old table and rename new one
      DROP TABLE sessions;
      ALTER TABLE sessions_new RENAME TO sessions;

      -- Recreate index
      CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
    `);
    console.error("Migrated sessions table to support multi-workspace");
  }
} catch (e) {
  console.error("Sessions migration error:", e.message);
}

// Prepared statements
const insertDecision = db.prepare(
  "INSERT INTO decisions (project, date, decision, rationale, category) VALUES (?, ?, ?, ?, ?)"
);
const getDecisions = db.prepare(
  "SELECT * FROM decisions WHERE project = ? AND (archived IS NULL OR archived = 0) ORDER BY priority DESC, date DESC LIMIT ?"
);
const getDecisionsByCategory = db.prepare(
  "SELECT * FROM decisions WHERE project = ? AND category = ? AND (archived IS NULL OR archived = 0) ORDER BY priority DESC, date DESC LIMIT ?"
);
const searchDecisions = db.prepare(
  "SELECT * FROM decisions WHERE project = ? AND (archived IS NULL OR archived = 0) AND (decision LIKE ? OR rationale LIKE ?) ORDER BY priority DESC, date DESC"
);

const insertError = db.prepare(
  "INSERT INTO errors (project, error_pattern, solution, context, category) VALUES (?, ?, ?, ?, ?)"
);
const findSolution = db.prepare(
  "SELECT * FROM errors WHERE project = ? AND (archived IS NULL OR archived = 0) AND error_pattern LIKE ? ORDER BY priority DESC, created_at DESC LIMIT 5"
);
const findSolutionByCategory = db.prepare(
  "SELECT * FROM errors WHERE project = ? AND category = ? AND (archived IS NULL OR archived = 0) AND error_pattern LIKE ? ORDER BY priority DESC, created_at DESC LIMIT 5"
);
const getRecentErrors = db.prepare(
  "SELECT * FROM errors WHERE project = ? AND (archived IS NULL OR archived = 0) ORDER BY priority DESC, created_at DESC LIMIT ?"
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
  "SELECT * FROM learnings WHERE (project = ? OR project IS NULL) AND (archived IS NULL OR archived = 0) ORDER BY priority DESC, created_at DESC LIMIT ?"
);
const searchLearnings = db.prepare(
  "SELECT * FROM learnings WHERE (project = ? OR project IS NULL) AND (archived IS NULL OR archived = 0) AND content LIKE ? ORDER BY priority DESC, created_at DESC"
);

const upsertSessionWithWorkspace = db.prepare(`
  INSERT INTO sessions (project, workspace, task, status, notes, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(project, workspace) DO UPDATE SET task = excluded.task, status = excluded.status, notes = excluded.notes, updated_at = CURRENT_TIMESTAMP
`);
const getSessionWithWorkspace = db.prepare(
  "SELECT * FROM sessions WHERE project = ? AND (workspace = ? OR (workspace IS NULL AND ? IS NULL))"
);
const deleteSessionWithWorkspace = db.prepare(
  "DELETE FROM sessions WHERE project = ? AND (workspace = ? OR (workspace IS NULL AND ? IS NULL))"
);
const getAllSessionsForProject = db.prepare(
  "SELECT * FROM sessions WHERE project = ? ORDER BY updated_at DESC"
);

// Access tracking for memory tiers (v2.7.0)
const trackDecisionAccess = db.prepare(
  "UPDATE decisions SET access_count = COALESCE(access_count, 0) + 1, last_accessed = CURRENT_TIMESTAMP WHERE id = ?"
);
const trackErrorAccess = db.prepare(
  "UPDATE errors SET access_count = COALESCE(access_count, 0) + 1, last_accessed = CURRENT_TIMESTAMP WHERE id = ?"
);
const trackLearningAccess = db.prepare(
  "UPDATE learnings SET access_count = COALESCE(access_count, 0) + 1, last_accessed = CURRENT_TIMESTAMP WHERE id = ?"
);

// Create MCP server
const server = new Server(
  {
    name: "claude-memory",
    version: "2.7.0",
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
            category: { type: "string", description: "Category (e.g., 'architecture', 'security', 'api', 'ui', 'devops')" },
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
            category: { type: "string", description: "Filter by category (e.g., 'architecture', 'security')" },
            limit: { type: "number", description: "Max results (default 10)" },
          },
          required: ["project"],
        },
      },
      {
        name: "list_decisions",
        description: "List recent decisions for a project without requiring a search term",
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
        name: "remember_error",
        description: "Store an error and its solution for future reference",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name" },
            error_pattern: { type: "string", description: "Error message or pattern to match" },
            solution: { type: "string", description: "How the error was fixed" },
            context: { type: "string", description: "Additional context about when this occurs" },
            category: { type: "string", description: "Category (e.g., 'build', 'runtime', 'api', 'database', 'auth')" },
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
            category: { type: "string", description: "Filter by category (e.g., 'build', 'runtime', 'api')" },
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
            workspace: { type: "string", description: "Workspace name (e.g., 'claude-3', 'claude-5') - use to avoid conflicts between Claude instances" },
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
            workspace: { type: "string", description: "Workspace name (e.g., 'claude-3', 'claude-5') - if not provided, returns all sessions for project" },
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
            workspace: { type: "string", description: "Workspace name (e.g., 'claude-3', 'claude-5') - if not provided, clears all sessions for project" },
          },
          required: ["project"],
        },
      },
      {
        name: "memory_status",
        description: "Get a summary of all memory for a project - call this at session start to quickly recall context",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name" },
          },
          required: ["project"],
        },
      },
      {
        name: "load_comprehensive_memory",
        description: "Load comprehensive memory for a project with higher limits - use this for thorough session starts. Returns 30 decisions, 50 learnings, 15 errors, all context, and all sessions.",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name" },
            include_global: { type: "boolean", description: "Also load global context (default: true)" },
          },
          required: ["project"],
        },
      },
      {
        name: "archive",
        description: "Archive old decisions, errors, or learnings by ID (they won't appear in queries but aren't deleted)",
        inputSchema: {
          type: "object",
          properties: {
            type: { type: "string", description: "Type to archive: 'decision', 'error', or 'learning'" },
            id: { type: "number", description: "ID of the item to archive" },
          },
          required: ["type", "id"],
        },
      },
      {
        name: "set_priority",
        description: "Set priority level for a decision, error, or learning. Higher priority items are loaded first in queries.",
        inputSchema: {
          type: "object",
          properties: {
            type: { type: "string", description: "Type: 'decision', 'error', or 'learning'" },
            id: { type: "number", description: "ID of the item" },
            priority: { type: "number", description: "Priority level: 0 = normal (default), 1 = high, 2 = critical" },
          },
          required: ["type", "id", "priority"],
        },
      },
      {
        name: "prune",
        description: "Permanently delete archived items older than specified days",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name (or 'all' for all projects)" },
            days: { type: "number", description: "Delete archived items older than this many days (default: 90)" },
          },
          required: ["project"],
        },
      },
      {
        name: "export_memory",
        description: "Export all memory for a project to JSON format",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name" },
            include_archived: { type: "boolean", description: "Include archived items (default: false)" },
          },
          required: ["project"],
        },
      },
      {
        name: "import_memory",
        description: "Import memory from JSON format (merges with existing data)",
        inputSchema: {
          type: "object",
          properties: {
            json_data: { type: "string", description: "JSON string containing memory data to import" },
          },
          required: ["json_data"],
        },
      },
      {
        name: "memory_stats",
        description: "Get detailed memory usage statistics including counts per project and database size",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Optional: filter stats to a specific project" },
          },
          required: [],
        },
      },
      {
        name: "bulk_cleanup",
        description: "Bulk delete old or archived items from memory",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name (or 'all' for all projects)" },
            type: { type: "string", description: "Type to clean: 'decisions', 'errors', 'learnings', or 'all'" },
            older_than_days: { type: "number", description: "Delete items older than this many days" },
            archived_only: { type: "boolean", description: "Only delete archived items (default: true)" },
          },
          required: ["project", "older_than_days"],
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
        const result = insertDecision.run(args.project, date, args.decision, args.rationale || null, args.category || null);

        // Sync to cloud if enabled
        if (firestoreSync) {
          await firestoreSync.syncToCloud("decisions", {
            id: result.lastInsertRowid,
            project: args.project,
            date,
            decision: args.decision,
            rationale: args.rationale,
            category: args.category,
          });
        }

        const categoryText = args.category ? ` [${args.category}]` : '';
        return { content: [{ type: "text", text: `Decision stored for ${args.project}${categoryText}${firestoreSync ? ' (synced)' : ''}` }] };
      }

      case "recall_decisions": {
        let results;
        if (args.category) {
          results = getDecisionsByCategory.all(args.project, args.category, args.limit || 10);
        } else if (args.search) {
          const pattern = `%${args.search}%`;
          results = searchDecisions.all(args.project, pattern, pattern);
        } else {
          results = getDecisions.all(args.project, args.limit || 10);
        }
        // Track access for memory tiers
        results.forEach(r => trackDecisionAccess.run(r.id));
        return {
          content: [{
            type: "text",
            text: results.length > 0
              ? results.map(r => {
                  const categoryTag = r.category ? ` [${r.category}]` : '';
                  return `[${r.date}]${categoryTag} ${r.decision}\n  Rationale: ${r.rationale || 'N/A'}`;
                }).join("\n\n")
              : "No decisions found for this project"
          }]
        };
      }

      case "list_decisions": {
        const results = getDecisions.all(args.project, args.limit || 10);
        return {
          content: [{
            type: "text",
            text: results.length > 0
              ? results.map(r => {
                  const categoryTag = r.category ? ` [${r.category}]` : '';
                  return `[ID:${r.id}] [${r.date}]${categoryTag} ${r.decision}\n  Rationale: ${r.rationale || 'N/A'}`;
                }).join("\n\n")
              : "No decisions found for this project"
          }]
        };
      }

      case "remember_error": {
        const result = insertError.run(args.project, args.error_pattern, args.solution, args.context || null, args.category || null);

        if (firestoreSync) {
          await firestoreSync.syncToCloud("errors", {
            id: result.lastInsertRowid,
            project: args.project,
            error_pattern: args.error_pattern,
            solution: args.solution,
            context: args.context,
            category: args.category,
          });
        }

        const categoryText = args.category ? ` [${args.category}]` : '';
        return { content: [{ type: "text", text: `Error solution stored for ${args.project}${categoryText}${firestoreSync ? ' (synced)' : ''}` }] };
      }

      case "find_solution": {
        const pattern = `%${args.error}%`;
        let results;
        if (args.category) {
          results = findSolutionByCategory.all(args.project, args.category, pattern);
        } else {
          results = findSolution.all(args.project, pattern);
        }
        // Track access for memory tiers
        results.forEach(r => trackErrorAccess.run(r.id));
        return {
          content: [{
            type: "text",
            text: results.length > 0
              ? results.map(r => {
                  const categoryTag = r.category ? ` [${r.category}]` : '';
                  return `Error:${categoryTag} ${r.error_pattern}\nSolution: ${r.solution}\nContext: ${r.context || 'N/A'}`;
                }).join("\n\n---\n\n")
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
        // Track access for memory tiers
        results.forEach(r => trackLearningAccess.run(r.id));
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
              ? results.map(r => {
                  const categoryTag = r.category ? ` [${r.category}]` : '';
                  return `[ID:${r.id}]${categoryTag} ${r.error_pattern}\n  Solution: ${r.solution}\n  Context: ${r.context || 'N/A'}`;
                }).join("\n\n")
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
        const workspace = args.workspace || null;
        upsertSessionWithWorkspace.run(args.project, workspace, args.task, args.status || 'in-progress', args.notes || null);

        if (firestoreSync) {
          await firestoreSync.syncToCloud("sessions", {
            id: workspace ? `${args.project}:${workspace}` : args.project,
            project: args.project,
            workspace: workspace,
            task: args.task,
            status: args.status,
            notes: args.notes,
          });
        }

        const workspaceInfo = workspace ? ` (workspace: ${workspace})` : '';
        return { content: [{ type: "text", text: `Session saved for ${args.project}${workspaceInfo}: ${args.task}${firestoreSync ? ' (synced)' : ''}` }] };
      }

      case "get_session": {
        const workspace = args.workspace;
        if (workspace !== undefined) {
          // Get specific workspace session
          const session = getSessionWithWorkspace.get(args.project, workspace, workspace);
          if (session) {
            const timeAgo = getTimeAgo(session.updated_at);
            const workspaceInfo = session.workspace ? ` [${session.workspace}]` : '';
            return {
              content: [{
                type: "text",
                text: `Last session${workspaceInfo} (${timeAgo}):\nTask: ${session.task}\nStatus: ${session.status || 'in-progress'}\nNotes: ${session.notes || 'None'}`
              }]
            };
          }
          return { content: [{ type: "text", text: "No saved session found" }] };
        } else {
          // Get all sessions for project
          const sessions = getAllSessionsForProject.all(args.project);
          if (sessions.length > 0) {
            const output = sessions.map(session => {
              const timeAgo = getTimeAgo(session.updated_at);
              const workspaceInfo = session.workspace ? `[${session.workspace}] ` : '[default] ';
              return `${workspaceInfo}(${timeAgo}):\n  Task: ${session.task}\n  Status: ${session.status || 'in-progress'}\n  Notes: ${session.notes || 'None'}`;
            }).join('\n\n');
            return { content: [{ type: "text", text: output }] };
          }
          return { content: [{ type: "text", text: "No saved session found" }] };
        }
      }

      case "clear_session": {
        const workspace = args.workspace;
        if (workspace !== undefined) {
          const result = deleteSessionWithWorkspace.run(args.project, workspace, workspace);
          const workspaceInfo = workspace ? ` (workspace: ${workspace})` : '';
          return {
            content: [{
              type: "text",
              text: result.changes > 0 ? `Session cleared for ${args.project}${workspaceInfo}` : "No session to clear"
            }]
          };
        } else {
          // Clear all sessions for project
          const result = db.prepare("DELETE FROM sessions WHERE project = ?").run(args.project);
          return {
            content: [{
              type: "text",
              text: result.changes > 0 ? `All sessions cleared for ${args.project} (${result.changes} session(s))` : "No sessions to clear"
            }]
          };
        }
      }

      case "memory_status": {
        // Get comprehensive summary for session start
        const sessions = getAllSessionsForProject.all(args.project);
        const contextItems = getContext.all(args.project);
        const decisions = getDecisions.all(args.project, 5);
        const learnings = getLearnings.all(args.project, 5);
        const errors = getRecentErrors.all(args.project, 3);

        // Also get global learnings
        const globalLearnings = db.prepare(
          "SELECT * FROM learnings WHERE project IS NULL AND (archived IS NULL OR archived = 0) ORDER BY created_at DESC LIMIT 5"
        ).all();

        let output = [`# Memory Status for ${args.project}\n`];

        // Session status (show all workspace sessions)
        if (sessions.length > 0) {
          output.push(`## 📋 Active Sessions (${sessions.length})`);
          for (const session of sessions) {
            const timeAgo = getTimeAgo(session.updated_at);
            const workspaceLabel = session.workspace ? `[${session.workspace}]` : '[default]';
            output.push(`### ${workspaceLabel} (${timeAgo})`);
            output.push(`**Task:** ${session.task}`);
            output.push(`**Status:** ${session.status || 'in-progress'}`);
            if (session.notes) output.push(`**Notes:** ${session.notes}`);
            output.push('');
          }
        }

        // Context
        if (contextItems.length > 0) {
          output.push(`## ⚙️ Context (${contextItems.length} items)`);
          contextItems.forEach(c => output.push(`- **${c.key}:** ${c.value}`));
          output.push('');
        }

        // Recent decisions
        if (decisions.length > 0) {
          output.push(`## 🎯 Recent Decisions`);
          decisions.forEach(d => output.push(`- [${d.date}] ${d.decision}`));
          output.push('');
        }

        // Recent learnings (project + global)
        const allLearnings = [...learnings, ...globalLearnings.filter(g => !learnings.find(l => l.id === g.id))];
        if (allLearnings.length > 0) {
          output.push(`## 💡 Learnings`);
          allLearnings.slice(0, 5).forEach(l => output.push(`- [${l.category}] ${l.content}${l.project ? '' : ' (global)'}`));
          output.push('');
        }

        // Recent errors
        if (errors.length > 0) {
          output.push(`## 🐛 Recent Error Solutions`);
          errors.forEach(e => output.push(`- **${e.error_pattern}**: ${e.solution}`));
          output.push('');
        }

        // Stats
        const stats = {
          decisions: db.prepare("SELECT COUNT(*) as count FROM decisions WHERE project = ? AND (archived IS NULL OR archived = 0)").get(args.project).count,
          errors: db.prepare("SELECT COUNT(*) as count FROM errors WHERE project = ? AND (archived IS NULL OR archived = 0)").get(args.project).count,
          learnings: db.prepare("SELECT COUNT(*) as count FROM learnings WHERE (project = ? OR project IS NULL) AND (archived IS NULL OR archived = 0)").get(args.project).count,
          context: contextItems.length,
        };
        output.push(`## 📊 Stats`);
        output.push(`Decisions: ${stats.decisions} | Errors: ${stats.errors} | Learnings: ${stats.learnings} | Context: ${stats.context}`);

        return { content: [{ type: "text", text: output.join('\n') }] };
      }

      case "load_comprehensive_memory": {
        // Load comprehensive memory with higher limits for thorough session starts
        const includeGlobal = args.include_global !== false;

        // Higher limits for comprehensive loading
        const DECISION_LIMIT = 30;
        const LEARNING_LIMIT = 50;
        const ERROR_LIMIT = 15;

        const sessions = getAllSessionsForProject.all(args.project);
        const contextItems = getContext.all(args.project);
        const decisions = getDecisions.all(args.project, DECISION_LIMIT);
        const learnings = getLearnings.all(args.project, LEARNING_LIMIT);
        const errors = getRecentErrors.all(args.project, ERROR_LIMIT);

        // Get global context and learnings if requested
        let globalContext = [];
        let globalLearnings = [];
        if (includeGlobal) {
          globalContext = getContext.all('global');
          globalLearnings = db.prepare(
            "SELECT * FROM learnings WHERE project IS NULL AND (archived IS NULL OR archived = 0) ORDER BY created_at DESC LIMIT 20"
          ).all();
        }

        let output = [`# Comprehensive Memory for ${args.project}\n`];
        output.push(`_Loaded with higher limits: ${DECISION_LIMIT} decisions, ${LEARNING_LIMIT} learnings, ${ERROR_LIMIT} errors_\n`);

        // Global context (if included)
        if (includeGlobal && globalContext.length > 0) {
          output.push(`## 🌐 Global Context`);
          globalContext.forEach(c => output.push(`- **${c.key}:** ${c.value}`));
          output.push('');
        }

        // Session status (show all workspace sessions)
        if (sessions.length > 0) {
          output.push(`## 📋 Active Sessions (${sessions.length})`);
          for (const session of sessions) {
            const timeAgo = getTimeAgo(session.updated_at);
            const workspaceLabel = session.workspace ? `[${session.workspace}]` : '[default]';
            output.push(`### ${workspaceLabel} (${timeAgo})`);
            output.push(`**Task:** ${session.task}`);
            output.push(`**Status:** ${session.status || 'in-progress'}`);
            if (session.notes) output.push(`**Notes:** ${session.notes}`);
            output.push('');
          }
        }

        // Project context
        if (contextItems.length > 0) {
          output.push(`## ⚙️ Project Context (${contextItems.length} items)`);
          contextItems.forEach(c => output.push(`- **${c.key}:** ${c.value}`));
          output.push('');
        }

        // Helper for priority indicator
        const priorityIcon = (p) => p === 2 ? '🔴 ' : p === 1 ? '🟡 ' : '';

        // Helper for memory tier classification (v2.7.0)
        const getTier = (item) => {
          const accessCount = item.access_count || 0;
          const lastAccessed = item.last_accessed ? new Date(item.last_accessed) : null;
          const now = new Date();
          const daysSinceAccess = lastAccessed ? (now - lastAccessed) / (1000 * 60 * 60 * 24) : Infinity;

          // Hot: frequently accessed (5+) or recently accessed (7 days)
          if (accessCount >= 5 || daysSinceAccess <= 7) return 'hot';
          // Warm: moderately accessed (2+) or accessed within 30 days
          if (accessCount >= 2 || daysSinceAccess <= 30) return 'warm';
          // Cold: rarely or never accessed
          return 'cold';
        };
        const tierIcon = (tier) => tier === 'hot' ? '🔥' : tier === 'warm' ? '⭐' : '';

        // Decisions (with dates and rationales)
        if (decisions.length > 0) {
          const highPriorityCount = decisions.filter(d => (d.priority || 0) > 0).length;
          const hotCount = decisions.filter(d => getTier(d) === 'hot').length;
          output.push(`## 🎯 Decisions (${decisions.length}${highPriorityCount ? `, ${highPriorityCount} priority` : ''}${hotCount ? `, ${hotCount} hot` : ''})`);
          decisions.forEach(d => {
            const categoryTag = d.category ? `[${d.category}] ` : '';
            const tier = tierIcon(getTier(d));
            output.push(`- ${priorityIcon(d.priority)}${tier}**[${d.date}]** ${categoryTag}${d.decision}`);
            if (d.rationale) output.push(`  _Rationale: ${d.rationale}_`);
          });
          output.push('');
        }

        // Learnings (project + global combined, deduplicated)
        const allLearnings = [...learnings];
        if (includeGlobal) {
          globalLearnings.forEach(g => {
            if (!allLearnings.find(l => l.id === g.id)) {
              allLearnings.push(g);
            }
          });
        }
        if (allLearnings.length > 0) {
          const highPriorityCount = allLearnings.filter(l => (l.priority || 0) > 0).length;
          const hotCount = allLearnings.filter(l => getTier(l) === 'hot').length;
          output.push(`## 💡 Learnings (${allLearnings.length}${highPriorityCount ? `, ${highPriorityCount} priority` : ''}${hotCount ? `, ${hotCount} hot` : ''})`);
          allLearnings.forEach(l => {
            const tier = tierIcon(getTier(l));
            output.push(`- ${priorityIcon(l.priority)}${tier}[${l.category}] ${l.content}${l.project ? '' : ' _(global)_'}`);
          });
          output.push('');
        }

        // Error solutions
        if (errors.length > 0) {
          const highPriorityCount = errors.filter(e => (e.priority || 0) > 0).length;
          const hotCount = errors.filter(e => getTier(e) === 'hot').length;
          output.push(`## 🐛 Error Solutions (${errors.length}${highPriorityCount ? `, ${highPriorityCount} priority` : ''}${hotCount ? `, ${hotCount} hot` : ''})`);
          errors.forEach(e => {
            const categoryTag = e.category ? `[${e.category}] ` : '';
            const tier = tierIcon(getTier(e));
            output.push(`- ${priorityIcon(e.priority)}${tier}${categoryTag}**${e.error_pattern}**`);
            output.push(`  Solution: ${e.solution}`);
            if (e.context) output.push(`  Context: ${e.context}`);
          });
          output.push('');
        }

        // Summary stats
        const stats = {
          decisions: db.prepare("SELECT COUNT(*) as count FROM decisions WHERE project = ? AND (archived IS NULL OR archived = 0)").get(args.project).count,
          errors: db.prepare("SELECT COUNT(*) as count FROM errors WHERE project = ? AND (archived IS NULL OR archived = 0)").get(args.project).count,
          learnings: db.prepare("SELECT COUNT(*) as count FROM learnings WHERE (project = ? OR project IS NULL) AND (archived IS NULL OR archived = 0)").get(args.project).count,
          context: contextItems.length,
        };
        output.push(`## 📊 Total Available`);
        output.push(`Decisions: ${stats.decisions} (loaded: ${decisions.length}) | Errors: ${stats.errors} (loaded: ${errors.length}) | Learnings: ${stats.learnings} (loaded: ${allLearnings.length}) | Context: ${stats.context}`);

        return { content: [{ type: "text", text: output.join('\n') }] };
      }

      case "archive": {
        const tableMap = {
          'decision': 'decisions',
          'error': 'errors',
          'learning': 'learnings',
        };
        const table = tableMap[args.type];
        if (!table) {
          return { content: [{ type: "text", text: `Invalid type: ${args.type}. Use 'decision', 'error', or 'learning'` }] };
        }

        const result = db.prepare(`UPDATE ${table} SET archived = 1 WHERE id = ?`).run(args.id);
        return {
          content: [{
            type: "text",
            text: result.changes > 0
              ? `Archived ${args.type} #${args.id}`
              : `No ${args.type} found with ID ${args.id}`
          }]
        };
      }

      case "set_priority": {
        const tableMap = {
          'decision': 'decisions',
          'error': 'errors',
          'learning': 'learnings',
        };
        const table = tableMap[args.type];
        if (!table) {
          return { content: [{ type: "text", text: `Invalid type: ${args.type}. Use 'decision', 'error', or 'learning'` }] };
        }

        const priority = args.priority;
        if (priority < 0 || priority > 2) {
          return { content: [{ type: "text", text: `Invalid priority: ${priority}. Use 0 (normal), 1 (high), or 2 (critical)` }] };
        }

        const priorityLabels = ['normal', 'high', 'critical'];
        const result = db.prepare(`UPDATE ${table} SET priority = ? WHERE id = ?`).run(priority, args.id);
        return {
          content: [{
            type: "text",
            text: result.changes > 0
              ? `Set ${args.type} #${args.id} priority to ${priorityLabels[priority]} (${priority})`
              : `No ${args.type} found with ID ${args.id}`
          }]
        };
      }

      case "prune": {
        const days = args.days || 90;
        const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

        let totalDeleted = 0;
        const tables = ['decisions', 'errors', 'learnings'];

        for (const table of tables) {
          let query = `DELETE FROM ${table} WHERE archived = 1 AND created_at < ?`;
          if (args.project !== 'all') {
            query += ` AND project = ?`;
          }

          const result = args.project !== 'all'
            ? db.prepare(query).run(cutoffDate, args.project)
            : db.prepare(query).run(cutoffDate);

          totalDeleted += result.changes;
        }

        return {
          content: [{
            type: "text",
            text: `Pruned ${totalDeleted} archived items older than ${days} days`
          }]
        };
      }

      case "export_memory": {
        const includeArchived = args.include_archived || false;
        const archivedFilter = includeArchived ? '' : 'AND (archived IS NULL OR archived = 0)';

        const data = {
          project: args.project,
          exported_at: new Date().toISOString(),
          decisions: db.prepare(`SELECT * FROM decisions WHERE project = ? ${archivedFilter}`).all(args.project),
          errors: db.prepare(`SELECT * FROM errors WHERE project = ? ${archivedFilter}`).all(args.project),
          context: db.prepare(`SELECT * FROM context WHERE project = ?`).all(args.project),
          learnings: db.prepare(`SELECT * FROM learnings WHERE project = ? ${archivedFilter}`).all(args.project),
          session: getSession.get(args.project),
        };

        return {
          content: [{
            type: "text",
            text: JSON.stringify(data, null, 2)
          }]
        };
      }

      case "import_memory": {
        try {
          const data = JSON.parse(args.json_data);
          let imported = { decisions: 0, errors: 0, context: 0, learnings: 0 };

          // Import decisions
          if (data.decisions) {
            for (const d of data.decisions) {
              try {
                insertDecision.run(d.project, d.date, d.decision, d.rationale);
                imported.decisions++;
              } catch (e) { /* skip duplicates */ }
            }
          }

          // Import errors
          if (data.errors) {
            for (const e of data.errors) {
              try {
                insertError.run(e.project, e.error_pattern, e.solution, e.context);
                imported.errors++;
              } catch (e) { /* skip duplicates */ }
            }
          }

          // Import context (upsert)
          if (data.context) {
            for (const c of data.context) {
              upsertContext.run(c.project, c.key, c.value);
              imported.context++;
            }
          }

          // Import learnings
          if (data.learnings) {
            for (const l of data.learnings) {
              try {
                insertLearning.run(l.project, l.category, l.content);
                imported.learnings++;
              } catch (e) { /* skip duplicates */ }
            }
          }

          // Import session
          if (data.session) {
            upsertSession.run(data.session.project, data.session.task, data.session.status, data.session.notes);
          }

          return {
            content: [{
              type: "text",
              text: `Imported: ${imported.decisions} decisions, ${imported.errors} errors, ${imported.context} context items, ${imported.learnings} learnings`
            }]
          };
        } catch (e) {
          return { content: [{ type: "text", text: `Import failed: ${e.message}` }] };
        }
      }

      case "memory_stats": {
        const { statSync } = await import("fs");

        // Get database file size
        let dbSize = "unknown";
        try {
          const stats = statSync(dbPath);
          const sizeKB = (stats.size / 1024).toFixed(2);
          const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
          dbSize = stats.size > 1024 * 1024 ? `${sizeMB} MB` : `${sizeKB} KB`;
        } catch (e) { /* ignore */ }

        let output = [`# Memory Statistics\n`, `Database size: ${dbSize}\n`];

        if (args.project) {
          // Stats for specific project
          const stats = {
            decisions: db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END) as archived FROM decisions WHERE project = ?").get(args.project),
            errors: db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END) as archived FROM errors WHERE project = ?").get(args.project),
            learnings: db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END) as archived FROM learnings WHERE project = ?").get(args.project),
            context: db.prepare("SELECT COUNT(*) as total FROM context WHERE project = ?").get(args.project),
          };

          output.push(`## Project: ${args.project}`);
          output.push(`- Decisions: ${stats.decisions.total} (${stats.decisions.archived || 0} archived)`);
          output.push(`- Errors: ${stats.errors.total} (${stats.errors.archived || 0} archived)`);
          output.push(`- Learnings: ${stats.learnings.total} (${stats.learnings.archived || 0} archived)`);
          output.push(`- Context keys: ${stats.context.total}`);
        } else {
          // Stats for all projects
          const projects = db.prepare(`
            SELECT DISTINCT project FROM (
              SELECT project FROM decisions
              UNION SELECT project FROM errors
              UNION SELECT project FROM context
              UNION SELECT project FROM learnings WHERE project IS NOT NULL
            ) ORDER BY project
          `).all();

          output.push(`## All Projects (${projects.length} total)\n`);

          for (const { project } of projects) {
            const decisions = db.prepare("SELECT COUNT(*) as count FROM decisions WHERE project = ?").get(project).count;
            const errors = db.prepare("SELECT COUNT(*) as count FROM errors WHERE project = ?").get(project).count;
            const learnings = db.prepare("SELECT COUNT(*) as count FROM learnings WHERE project = ?").get(project).count;
            const context = db.prepare("SELECT COUNT(*) as count FROM context WHERE project = ?").get(project).count;
            output.push(`**${project}**: ${decisions} decisions, ${errors} errors, ${learnings} learnings, ${context} context`);
          }

          // Global learnings
          const globalLearnings = db.prepare("SELECT COUNT(*) as count FROM learnings WHERE project IS NULL").get().count;
          output.push(`\n**Global learnings**: ${globalLearnings}`);

          // Totals
          const totals = {
            decisions: db.prepare("SELECT COUNT(*) as count FROM decisions").get().count,
            errors: db.prepare("SELECT COUNT(*) as count FROM errors").get().count,
            learnings: db.prepare("SELECT COUNT(*) as count FROM learnings").get().count,
            context: db.prepare("SELECT COUNT(*) as count FROM context").get().count,
            archived: db.prepare(`
              SELECT
                (SELECT COUNT(*) FROM decisions WHERE archived = 1) +
                (SELECT COUNT(*) FROM errors WHERE archived = 1) +
                (SELECT COUNT(*) FROM learnings WHERE archived = 1) as count
            `).get().count,
          };
          output.push(`\n## Totals`);
          output.push(`- Total decisions: ${totals.decisions}`);
          output.push(`- Total errors: ${totals.errors}`);
          output.push(`- Total learnings: ${totals.learnings}`);
          output.push(`- Total context keys: ${totals.context}`);
          output.push(`- Total archived items: ${totals.archived}`);
        }

        return { content: [{ type: "text", text: output.join('\n') }] };
      }

      case "bulk_cleanup": {
        const days = args.older_than_days;
        const archivedOnly = args.archived_only !== false; // default true
        const typeFilter = args.type || 'all';
        const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

        const tables = typeFilter === 'all'
          ? ['decisions', 'errors', 'learnings']
          : [typeFilter];

        let totalDeleted = 0;
        const deletedPerTable = {};

        for (const table of tables) {
          if (!['decisions', 'errors', 'learnings'].includes(table)) {
            continue;
          }

          let conditions = ['created_at < ?'];
          let params = [cutoffDate];

          if (archivedOnly) {
            conditions.push('archived = 1');
          }

          if (args.project !== 'all') {
            conditions.push('project = ?');
            params.push(args.project);
          }

          const query = `DELETE FROM ${table} WHERE ${conditions.join(' AND ')}`;
          const result = db.prepare(query).run(...params);
          deletedPerTable[table] = result.changes;
          totalDeleted += result.changes;
        }

        const details = Object.entries(deletedPerTable)
          .map(([table, count]) => `${table}: ${count}`)
          .join(', ');

        return {
          content: [{
            type: "text",
            text: `Deleted ${totalDeleted} items older than ${days} days${archivedOnly ? ' (archived only)' : ''}\n${details}`
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
  console.error(`Claude Memory MCP server running (v2.3.0)${firestoreSync ? ' [Firestore enabled]' : ''}`);
}

main().catch(console.error);
