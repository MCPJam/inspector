---
"@mcpjam/inspector": patch
---

Retry slow server-check queue calls instead of failing hosted connects with "Server check queue is temporarily unavailable", so a call waiting on sign-in is no longer cancelled.
