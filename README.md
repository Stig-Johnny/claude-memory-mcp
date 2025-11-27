# Claude Memory MCP Server

A Model Context Protocol (MCP) server that provides persistent memory capabilities for Claude Code. Store decisions, error solutions, project context, learnings, and session state across conversations.

## Features

- **Decisions**: Track architectural and design decisions with rationale
- **Error Solutions**: Store bug fixes and solutions for future reference
- **Project Context**: Key-value storage for project-specific settings (SDK versions, URLs, etc.)
- **Learnings**: Capture patterns, gotchas, and best practices
- **Sessions**: Save and restore work session state
- **Cloud Sync** (optional): Sync memory across machines using Google Cloud Firestore

## Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/Stig-Johnny/claude-memory-mcp.git ~/.claude/mcp-servers/claude-memory

# 2. Install dependencies
cd ~/.claude/mcp-servers/claude-memory
npm install

# 3. Add to Claude Code settings (~/.claude/settings.json)
```

Add this to your `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "claude-memory": {
      "command": "node",
      "args": ["/Users/YOUR_USERNAME/.claude/mcp-servers/claude-memory/index.js"]
    }
  }
}
```

Replace `YOUR_USERNAME` with your actual username (run `whoami` to check).

**4. Restart Claude Code** to load the MCP server.

## Database Location

The SQLite database is stored at `~/.claude/memory.db`. This file persists across Claude Code sessions.

---

## Integrating with Your Project's CLAUDE.md

To get the most out of claude-memory, add instructions to your project's `CLAUDE.md` file so Claude knows when and how to use the memory tools.

### Recommended CLAUDE.md Section

Add this to your project's `CLAUDE.md`:

```markdown
## 🧠 Persistent Memory (MCP)

This project uses the claude-memory MCP for cross-session context.

### At Session Start

Always recall context at the beginning of each session:

mcp__claude-memory__get_session(project: "my-project")
mcp__claude-memory__get_context(project: "my-project")
mcp__claude-memory__recall_decisions(project: "my-project", limit: 5)

### What to Store

| Type | Tool | When to Use |
|------|------|-------------|
| Config/URLs/versions | `set_context` | SDK versions, API URLs, bundle IDs |
| Architectural choices | `remember_decision` | Decisions with trade-offs worth documenting |
| Bug solutions | `remember_error` | Non-trivial bugs you might encounter again |
| Patterns/gotchas | `remember_learning` | Tips that save time |
| Work state | `save_session` | Before ending a session mid-task |

### Before Ending a Session (if work is incomplete)

save_session(
  project: "my-project",
  task: "What you were working on",
  status: "in-progress",
  notes: "Next steps to resume..."
)

### When Task is Complete

clear_session(project: "my-project")
```

### Example: Real-World CLAUDE.md Integration

Here's a more complete example from a production project:

```markdown
## 🧠 Persistent Memory

### At Session Start
Always run these to load context:
- `get_context(project: "my-app")` - Get SDK versions, URLs, config
- `recall_decisions(project: "my-app", limit: 10)` - Recent architectural decisions
- `get_session(project: "my-app")` - Check for unfinished work

### What to Remember

**Store context for:**
- `sdk_version` - Current SDK version number
- `api_url` - Production API endpoint
- `bundle_id` - iOS/Android bundle identifier

**Store decisions when:**
- Choosing between technologies (e.g., "Use SQLite over CoreData")
- Making trade-offs (e.g., "Polling vs WebSockets")
- Establishing patterns (e.g., "All API calls go through ApiClient")

**Store errors when:**
- The fix wasn't obvious
- You might encounter it again
- It took significant debugging time
```

---

## Best Practices

### Project Naming

Use consistent, short project names:
- ✅ `"my-app"` - short and clear
- ✅ `"my-app-ios"` - for related sub-projects
- ❌ `"My Application Project"` - too long

### Context Keys Convention

Use snake_case for context keys:
- `sdk_version`
- `api_url`
- `bundle_id`
- `production_api_key`

### What to Store vs. What NOT to Store

**DO store:**
- SDK versions, API URLs, bundle IDs
- Architectural decisions with rationale
- Non-obvious bug fixes
- Project-specific gotchas and patterns

**DON'T store:**
- Temporary debugging info
- Obvious/trivial fixes
- Secrets or credentials (use environment variables instead!)
- Information that changes every session

---

## Workflow Examples

### Starting a New Session

```
get_session(project: "my-app")              # Check for unfinished work
get_context(project: "my-app")              # Load project config
recall_decisions(project: "my-app", limit: 5)  # Recent decisions
```

### After Fixing a Tricky Bug

```
remember_error(
  project: "my-app",
  error_pattern: "SQLITE_CONSTRAINT: UNIQUE constraint failed",
  solution: "Use INSERT OR REPLACE instead of INSERT for upserts",
  context: "When upserting records in SQLite/D1"
)
```

### After Making an Architectural Decision

```
remember_decision(
  project: "my-app",
  decision: "Use polling instead of WebSockets for real-time updates",
  rationale: "WebSockets add complexity; our updates are infrequent (30s interval is acceptable)"
)
```

### Storing Project Configuration

```
set_context(project: "my-app", key: "sdk_version", value: "2.1.0")
set_context(project: "my-app", key: "api_url", value: "https://api.my-app.com")
set_context(project: "my-app", key: "min_ios_version", value: "15.0")
```

### Before Ending a Session Mid-Task

```
save_session(
  project: "my-app",
  task: "Implementing user authentication",
  status: "in-progress",
  notes: "JWT generation done. Still need: refresh tokens, logout endpoint, token expiry handling"
)
```

### When Task is Complete

```
clear_session(project: "my-app")
```

### Searching for Past Solutions

```
find_solution(project: "my-app", error: "UNIQUE constraint")
search_all(project: "my-app", query: "authentication")
```

### Quick Session Start (NEW in v2.1)

Instead of calling multiple tools, use `memory_status` for a comprehensive overview:

```
memory_status(project: "my-app")
```

Returns: active session, all context, recent decisions, learnings, error solutions, and stats in one call.

### Archiving Old Data

```
# Archive a specific decision (still in DB but hidden from queries)
archive(type: "decision", id: 42)

# Archive an error solution
archive(type: "error", id: 15)

# Permanently delete archived items older than 90 days
prune(project: "my-app", days: 90)

# Prune all projects
prune(project: "all", days: 90)
```

### Export / Import Memory

```
# Export project memory to JSON
export_memory(project: "my-app")

# Export including archived items
export_memory(project: "my-app", include_archived: true)

# Import from JSON (merges with existing data)
import_memory(json_data: '{"decisions": [...], "context": [...]}')
```

---

## Cloud Sync with Firestore (Multi-Machine Setup)

To sync your memory across multiple machines (e.g., home and work computers), set up Firestore:

### Step 1: Create Firebase Project

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Click **"Create a project"**
3. Name it (e.g., `claude-memory-mcp`)
4. Disable Google Analytics (not needed)
5. Click **Create**

### Step 2: Create Firestore Database

1. In Firebase Console, go to **Build → Firestore Database**
2. Click **"Create database"**
3. Choose **"Start in test mode"** (we'll secure it later)
4. Select a location:
   - `eur3` (Europe) - if you're in Europe
   - `nam5` (US) - if you're in the US
5. Click **Create**

### Step 3: Get Service Account Key

1. Go to **Project Settings** (gear icon) → **Service accounts** tab
2. Click **"Generate new private key"**
3. Save the downloaded JSON file to `~/.claude/firestore-key.json`

### Step 4: Create Config File

Create `~/.claude/memory-config.json`:

```json
{
  "machineId": "my-macbook",
  "firestore": {
    "enabled": true,
    "projectId": "claude-memory-mcp",
    "keyFilePath": "/Users/YOUR_USERNAME/.claude/firestore-key.json",
    "collectionPrefix": "claude-memory"
  }
}
```

**Important:**
- Replace `YOUR_USERNAME` with your actual username
- Replace `claude-memory-mcp` with your Firebase project ID
- Use a unique `machineId` for each computer (e.g., `macbook-home`, `macbook-work`)

### Step 5: Install Firestore Package

```bash
cd ~/.claude/mcp-servers/claude-memory
npm install @google-cloud/firestore
```

### Step 6: Restart Claude Code

Quit and reopen Claude Code. You should see `(synced)` after memory operations.

### Setting Up Additional Machines

On each additional machine:

1. Clone the repo:
   ```bash
   git clone https://github.com/Stig-Johnny/claude-memory-mcp.git ~/.claude/mcp-servers/claude-memory
   cd ~/.claude/mcp-servers/claude-memory
   npm install
   npm install @google-cloud/firestore
   ```

2. Copy these files from your first machine:
   - `~/.claude/firestore-key.json` (same key works on all machines)
   - `~/.claude/memory-config.json` (change `machineId` to be unique!)

3. Add MCP server to `~/.claude/settings.json` (same as Step 3 in Quick Start)

4. Restart Claude Code

### How Sync Works

- **Automatic sync on write**: When you store a decision, error, or context, it saves locally AND syncs to Firestore
- **Manual sync**: Use `sync_to_cloud` to push all local data, `pull_from_cloud` to fetch from cloud
- **Local-first**: Local SQLite is the primary database; Firestore is for cross-machine sync
- **Offline capable**: Works offline, syncs when connected

---

## Available Tools

### Decision Management

| Tool | Description |
|------|-------------|
| `remember_decision` | Store a project decision with rationale |
| `recall_decisions` | Retrieve past decisions (with optional search) |

### Error Solutions

| Tool | Description |
|------|-------------|
| `remember_error` | Store an error pattern and its solution |
| `find_solution` | Search for solutions to an error |
| `list_errors` | List all stored errors for a project |

### Project Context

| Tool | Description |
|------|-------------|
| `set_context` | Store a key-value pair for a project |
| `get_context` | Get stored context (all keys or specific key) |
| `delete_context` | Remove a context key |

### Learnings

| Tool | Description |
|------|-------------|
| `remember_learning` | Store a learning (pattern, gotcha, best-practice) |
| `recall_learnings` | Retrieve past learnings |

### Session Management

| Tool | Description |
|------|-------------|
| `save_session` | Save current work state before ending |
| `get_session` | Resume from last saved session |
| `clear_session` | Clear session when work is complete |
| `memory_status` | **NEW** Get comprehensive summary for session start (context, decisions, learnings, errors, stats) |

### Search

| Tool | Description |
|------|-------------|
| `search_all` | Search across all memory types |

### Maintenance

| Tool | Description |
|------|-------------|
| `archive` | **NEW** Archive old items by ID (won't appear in queries but not deleted) |
| `prune` | **NEW** Permanently delete archived items older than N days |
| `export_memory` | **NEW** Export all project memory to JSON |
| `import_memory` | **NEW** Import memory from JSON (merges with existing) |

### Cloud Sync (when Firestore enabled)

| Tool | Description |
|------|-------------|
| `sync_to_cloud` | Push local memory to Firestore |
| `pull_from_cloud` | Pull memory from Firestore |

---

## Multi-Project Support

Memory is organized by project name. Use consistent project names across sessions:

- `"my-app"` - Main application
- `"my-app-sdk"` - Related SDK
- `null` (for learnings) - Global learnings shared across all projects

---

## Backup and Migration

### Backup

```bash
cp ~/.claude/memory.db ~/.claude/memory.db.backup
```

### View Data with SQLite

```bash
sqlite3 ~/.claude/memory.db
.tables
SELECT * FROM decisions WHERE project = 'my-project';
```

### Export All Local Data to Firestore

If you have existing local data and want to migrate to cloud:

```
sync_to_cloud(project: "all")
```

---

## Troubleshooting

### Firestore Not Syncing (no "(synced)" message)

1. **Restart Claude Code** after creating the config file
2. Check config file exists and is valid:
   ```bash
   cat ~/.claude/memory-config.json | python3 -m json.tool
   ```
3. Check Firestore package is installed:
   ```bash
   cd ~/.claude/mcp-servers/claude-memory
   npm list @google-cloud/firestore
   ```

### Permission Denied Error

Make sure your service account has the "Cloud Datastore User" role:
1. Go to [GCP IAM Console](https://console.cloud.google.com/iam-admin/iam)
2. Find your service account (ends with `@your-project.iam.gserviceaccount.com`)
3. Add "Cloud Datastore User" role

### Key File Not Found

Verify the path in `memory-config.json` matches where you saved the key:
```bash
ls -la ~/.claude/firestore-key.json
```

---

## Security Notes

- **Keep `firestore-key.json` private** - never commit it to Git
- The service account key has access to your Firestore database
- Firebase "test mode" rules expire after 30 days - [set up proper rules](https://firebase.google.com/docs/firestore/security/get-started) for production
- **Never store secrets** (API keys, passwords) in memory - use environment variables

---

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

---

## License

MIT License - see [LICENSE](LICENSE) for details.
