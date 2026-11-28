---
"@mcpjam/sdk": patch
---

TTL And Poll Interval Shapes (`tasks-ttl-shape`) now accepts `ttl: null` on the 2025-11-25 tasks wire. The 2025-11-25 schema types `Task.ttl` as `number | null`, where null means "unlimited". A `ttl` of another type still fails, now with "legacy task ttl must be a number or null".
