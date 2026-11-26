---
"@mcpjam/sdk": patch
"@mcpjam/cli": patch
---

Removed the Tasks checks `tasks-wire-resolvable` and `tasks-declaration-hygiene`. Both graded MCPJam's own client, not the server: the first passed whenever a protocol version was negotiated (even on a server with no tasks), and the second read only the requests MCPJam sent. Every Tasks run scored both, so a server with no tasks at all collected two passed checks. Their rules now run as client tests in CI. The `mcp-tasks` profile is now `2026-11-26.1` and scores 12 checks, and the `dispatch` category, which held only these two, is gone. A config or `--check-id` list that still names them runs its other checks, and a list that names only them is refused with the reason; the same goes for `--category dispatch`. `REMOVED_MCP_TASKS_CHECK_IDS` and `REMOVED_MCP_TASKS_CHECK_CATEGORIES` list them.
