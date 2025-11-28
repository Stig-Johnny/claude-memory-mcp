# CLAUDE.md - Claude Memory MCP Server

This file provides guidance for Claude Code sessions working on the claude-memory-mcp project.

## Project Overview

**claude-memory-mcp** is a Model Context Protocol (MCP) server that provides persistent memory for Claude Code across sessions.

**Tech Stack:**
- Node.js (ES modules)
- SQLite via better-sqlite3 (local storage)
- Google Cloud Firestore (optional cloud sync)
- MCP SDK (@modelcontextprotocol/sdk)

**Repository:** https://github.com/Stig-Johnny/claude-memory-mcp

## Project Structure

```
claude-memory-mcp/
├── index.js              # Main MCP server (all logic in one file)
├── package.json          # Dependencies and metadata
├── memory-config.example.json  # Example config for Firestore
├── README.md             # User documentation
├── LICENSE               # MIT License
└── CLAUDE.md             # This file
```

## How It Works

1. **Local Storage**: SQLite database at `~/.claude/memory.db`
2. **MCP Protocol**: Exposes tools via stdin/stdout for Claude Code
3. **Cloud Sync** (optional): Syncs to Firestore when configured via `~/.claude/memory-config.json`

### Database Tables

| Table | Purpose |
|-------|---------|
| `decisions` | Architectural decisions with rationale |
| `errors` | Error patterns and their solutions |
| `context` | Key-value project configuration |
| `learnings` | Patterns, gotchas, best practices |
| `sessions` | Work-in-progress session state |

## Development

### Running Locally

The MCP server runs via Claude Code - it's not meant to be run standalone. To test:

1. Update `~/.claude/settings.json` to point to your local copy
2. Restart Claude Code
3. Test the tools in a conversation

### Making Changes

Since this is a single-file MCP server:
- All logic is in `index.js`
- Database schema is created inline (lines ~115-170)
- Tools are defined in the `ListToolsRequestSchema` handler
- Tool implementations are in the `CallToolRequestSchema` handler

### Testing Changes

After modifying `index.js`:
1. Restart Claude Code (the MCP server restarts with it)
2. Test the affected tools manually

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Single file (`index.js`) | Simple to understand and deploy |
| SQLite for local storage | No external dependencies, persists across sessions |
| Firestore for cloud sync | Works across machines, generous free tier |
| Optional cloud sync | Works offline, cloud is opt-in |
| Local-first architecture | Local SQLite is primary, Firestore is sync layer |

## Common Tasks

### Adding a New Tool

1. Add tool definition in `ListToolsRequestSchema` handler (~line 242)
2. Add tool implementation in `CallToolRequestSchema` switch statement (~line 452)
3. If it stores data, add Firestore sync call
4. Update README.md with the new tool

### Modifying Database Schema

1. Add new table/column in the `db.exec()` block (~line 115)
2. Add prepared statements if needed
3. Consider migration for existing users (SQLite doesn't support all ALTER TABLE operations)

### Updating Dependencies

```bash
npm update
npm audit fix
```

## 🧠 Persistent Memory

This project uses itself for memory! Use project name `"claude-memory-mcp"`.

### At Session Start

```
get_context(project: "claude-memory-mcp")
recall_decisions(project: "claude-memory-mcp", limit: 5)
```

### What to Remember

- Version changes and release notes
- Design decisions for the MCP architecture
- Bug fixes that were non-obvious

### Memory Maintenance (Keep Updated!)

After making changes to any project, update memory immediately:

| Change Type | Action |
|-------------|--------|
| New DB migration | Update `database_schema` context |
| New API endpoint | Update `api_endpoints` context |
| New file/module | Update `architecture_overview` context |
| Version bump | `set_context(key: "sdk_version", value: "X.X.X")` |
| Bug fix with lesson | `remember_learning(category: "gotcha", ...)` |
| Architecture decision | `remember_decision(...)` |
| Error solution found | `remember_error(...)` |

**Triggers to watch for:**
- Creating new source files
- Adding routes or endpoints
- Running database migrations
- Fixing bugs that took significant time
- Making decisions with trade-offs

**At session end:** Verify memory is updated before closing.

## Release Process

1. Update version in `package.json`
2. Update CHANGELOG (if we add one)
3. Commit and push to main
4. Users pull latest: `cd ~/.claude/mcp-servers/claude-memory && git pull`

## Security Notes

- Never commit `firestore-key.json` or `memory-config.json`
- The `.gitignore` excludes `.db` files and sensitive configs
- Users should never store actual secrets in memory (use env vars)

## License

MIT - see LICENSE file
