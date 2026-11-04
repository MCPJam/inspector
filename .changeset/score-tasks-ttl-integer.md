---
"@mcpjam/sdk": patch
---

Tasks conformance now scores `tasks-ttl-integer-shape` (profile `mcp-tasks` v2026-10-31.1), and the check reads every task payload the server sent (the creation result and each `tasks/get` answer), not just the final one. A task whose `ttlMs` or `pollIntervalMs` is not a whole number in any of them now fails the Tasks score, because the Tasks extension's schema types both fields as integers.
