---
"@mcpjam/sdk": patch
"@mcpjam/cli": patch
"@mcpjam/inspector": patch
---

Fix `oauth login` hanging ~95s after browser auth. The interactive callback server's `stop()` was using `server.closeIdleConnections()`, which does not drain the browser's favicon keep-alive socket. Switched to `closeAllConnections()`, which is safe here because `stop()` runs in `runOAuthLogin`'s `finally` block after the token exchange has returned.
