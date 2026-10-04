---
"@mcpjam/inspector": patch
---

Fix server connections getting stuck on browsers without AbortSignal.any, while preserving cancellation, timeouts, and connection queue priority.
