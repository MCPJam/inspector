---
"@mcpjam/inspector": patch
---

`/api/v1` project reads answer 404 "Project not found" for a malformed project id before calling the backend, instead of letting it reach a validator that reports it as an error.
