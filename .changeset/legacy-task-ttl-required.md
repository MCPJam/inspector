---
"@mcpjam/sdk": patch
---

TTL And Poll Interval Shapes (`tasks-ttl-shape`) now fails a 2025-11-25 task that has no `ttl`. The 2025-11-25 schema lists `ttl` as required on `Task`: a number, or null for unlimited. A task that sends the extension wire's `ttlMs` instead is named in the message.
