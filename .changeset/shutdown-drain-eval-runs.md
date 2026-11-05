---
"@mcpjam/inspector": patch
---

A configured shutdown drain also waits for eval runs started from the app or the API and for quick runs, not only for claimed jobs, before the server closes the connections they run on.
