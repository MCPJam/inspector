---
"@mcpjam/sdk": patch
---

Tasks conformance now scores `tasks-ttl-integer-shape` (profile `mcp-tasks` v2026-10-31.1). A task whose `ttlMs` or `pollIntervalMs` is not a whole number now fails the Tasks score, because the Tasks extension's schema types both fields as integers.
