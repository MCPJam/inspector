---
"@mcpjam/inspector": patch
---

chatboxes/tunnels: use `authFetch` with same-origin relative paths instead of manually fetching a WorkOS access token and prefixing requests with `VITE_API_BASE_URL` in `GenerateSessionsDialog` and the MCP tunnels API client; behavior unchanged, but requests now correctly pick up guest/local sessions in addition to WorkOS.
