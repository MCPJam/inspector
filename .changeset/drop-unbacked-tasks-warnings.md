---
"@mcpjam/sdk": patch
---

Tasks conformance: removed five warnings no spec rule backs — a leftover nested `task` object on a new task, an extra `ttl`/`ttlMs` from the other version, a non-number TTL (already failed by the TTL shape check), and a negative TTL.
