---
"@mcpjam/sdk": patch
---

Reconnect silent MCP Events beta HTTP streams after three server-granted heartbeat intervals using the last committed cursor. On stdio, use stream closure to detect a lost connection.
