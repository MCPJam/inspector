---
"@mcpjam/sdk": minor
---

Add `MCPClientManager.ensureManagedClient(serverId)`, which waits for a connection the manager queued at construction before handing over the server's client. Reading `getManagedClient` right after building a manager with servers can find the connect still running.
