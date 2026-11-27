---
"@mcpjam/sdk": patch
---

`MCPClientManager.pingServer` now closes the connection when a `ping` gets no answer in time, as the 2025 revisions ask ("Timeouts SHOULD be treated as connection failures"). The timeout is still thrown, and the next call on that server opens a new connection. A caller's own abort, any other ping error, and the 2026-07-28 `server/discover` probe leave the connection as it is.
