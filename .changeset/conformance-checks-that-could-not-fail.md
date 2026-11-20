---
"@mcpjam/sdk": patch
---

Two conformance results that could never go wrong now report what they actually saw.

- The tool-order advice asks the server for its tool list a second time instead of reading the cached copy. On a 2026-07-28 server that sends `ttlMs`, it used to compare the list with itself and never warned. It also stays silent when a tool was added or removed between the two listings: the spec asks for a stable order only while the set of tools is unchanged.
- Tool Output Schema Honored no longer passes a result whose output schema is written in a JSON Schema dialect other than 2020-12 or draft-07. Those results were never validated. The check now shows as "Not run" and names the tool and the dialect.
