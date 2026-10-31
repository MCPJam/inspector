---
"@mcpjam/sdk": patch
"@mcpjam/cli": patch
---

Tasks conformance: a server that lists the Tasks extension on a 2025-11-25 connection no longer gets a warning, since no rule forbids that. A new scored check, `tasks-legacy-ignores-extension-declaration`, tests the actual SEP-2663 rule instead: on 2025-11-25, a `tools/call` that declares the extension (and sends no `params.task`) must not come back as a task. The `mcp-tasks` profile moves to `2026-10-31.1`.
