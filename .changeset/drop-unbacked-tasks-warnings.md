---
"@mcpjam/sdk": patch
---

Tasks conformance: removed seven warnings no spec rule backs — a leftover nested `task` object on a new task, an extra `ttl`/`ttlMs` from the other version, a non-number TTL (already failed by the TTL shape check), a negative TTL, listing the Tasks extension on 2025-11-25, and `tasks/cancel` on an already-finished task answering -32602.
