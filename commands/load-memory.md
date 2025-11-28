# Load Session Memory

Load all persistent context at session start for project: **$ARGUMENTS**

Call these MCP tools in sequence:

1. `mcp__claude-memory__get_context(project: "global")` - User info, preferences, working style
2. `mcp__claude-memory__get_context(project: "$ARGUMENTS")` - Project URLs, versions, architecture
3. `mcp__claude-memory__get_session(project: "$ARGUMENTS")` - Check for saved work session
4. `mcp__claude-memory__recall_decisions(project: "$ARGUMENTS", limit: 10)` - Recent decisions
5. `mcp__claude-memory__recall_learnings(project: "$ARGUMENTS", limit: 10)` - Patterns and gotchas

After loading, summarize:
- Greet the user by name (from global context)
- Any saved session state (task in progress, blockers)
- Key project context (SDK versions, known issues)
- What you're ready to help with

If $ARGUMENTS is empty, ask the user which project to load.
