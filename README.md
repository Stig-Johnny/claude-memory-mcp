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

### Search

| Tool | Description |
|------|-------------|
| `search_all` | Search across all memory types |

### Cloud Sync (when Firestore enabled)

| Tool | Description |
|------|-------------|
| `sync_to_cloud` | Push local memory to Firestore |
| `pull_from_cloud` | Pull memory from Firestore |

---

## Usage Examples

### Store a Decision

```
remember_decision(
  project: "my-project",
  decision: "Use PostgreSQL instead of MongoDB",
  rationale: "Better support for complex queries and transactions"
)
```

### Store an Error Solution

```
remember_error(
  project: "my-project",
  error_pattern: "ECONNREFUSED 127.0.0.1:5432",
  solution: "Start PostgreSQL service: brew services start postgresql",
  context: "Database connection on macOS"
)
```

### Save Session State

```
save_session(
  project: "my-project",
  task: "Implementing user authentication",
  status: "in-progress",
  notes: "JWT token generation done, need to add refresh tokens"
)
```

### At Session Start

```
get_session(project: "my-project")
get_context(project: "my-project")
recall_decisions(project: "my-project", limit: 5)
```

### Sync Across Machines

```
# On Machine A (after making changes)
sync_to_cloud(project: "my-project")

# On Machine B (to get those changes)
pull_from_cloud(project: "my-project")
```

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

---

## License

MIT
