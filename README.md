# Claude Memory MCP Server

A Model Context Protocol (MCP) server that provides persistent memory capabilities for Claude Code. Store decisions, error solutions, project context, learnings, and session state across conversations.

## Features

- **Decisions**: Track architectural and design decisions with rationale
- **Error Solutions**: Store bug fixes and solutions for future reference
- **Project Context**: Key-value storage for project-specific settings (SDK versions, URLs, etc.)
- **Learnings**: Capture patterns, gotchas, and best practices
- **Sessions**: Save and restore work session state

## Installation

### Option 1: Clone and Install

```bash
# Clone the repository
git clone https://github.com/Stig-Johnny/claude-memory-mcp.git ~/.claude/mcp-servers/claude-memory

# Install dependencies
cd ~/.claude/mcp-servers/claude-memory
npm install
```

### Option 2: Manual Setup

```bash
# Create the directory
mkdir -p ~/.claude/mcp-servers/claude-memory
cd ~/.claude/mcp-servers/claude-memory

# Copy the files (index.js, package.json)
npm install
```

## Configuration

Add to your Claude Code MCP settings (`~/.claude/settings.json`):

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

Replace `YOUR_USERNAME` with your actual username.

## Database Location

The SQLite database is stored at `~/.claude/memory.db`. This file persists across Claude Code sessions.

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

## Database Schema

```sql
-- Decisions
CREATE TABLE decisions (
  id INTEGER PRIMARY KEY,
  project TEXT NOT NULL,
  date TEXT NOT NULL,
  decision TEXT NOT NULL,
  rationale TEXT,
  created_at TEXT
);

-- Errors
CREATE TABLE errors (
  id INTEGER PRIMARY KEY,
  project TEXT NOT NULL,
  error_pattern TEXT NOT NULL,
  solution TEXT NOT NULL,
  context TEXT,
  created_at TEXT
);

-- Context (key-value store)
CREATE TABLE context (
  id INTEGER PRIMARY KEY,
  project TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT,
  UNIQUE(project, key)
);

-- Learnings
CREATE TABLE learnings (
  id INTEGER PRIMARY KEY,
  project TEXT,  -- NULL for global learnings
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT
);

-- Sessions
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  project TEXT NOT NULL UNIQUE,
  task TEXT NOT NULL,
  status TEXT,
  notes TEXT,
  updated_at TEXT
);
```

## Multi-Project Support

Memory is organized by project name. Use consistent project names across sessions:

- `"my-app"` - Main application
- `"my-app-sdk"` - Related SDK
- `null` (for learnings) - Global learnings shared across all projects

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

## License

MIT
