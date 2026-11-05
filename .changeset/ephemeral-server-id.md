---
"@mcpjam/sdk": patch
---

`withEphemeralClient` names its one-off connection after the server (the HTTP endpoint's host, or the stdio command's name) instead of `__ephemeral__`. Conformance and other one-off runs that fail to connect, or meet a protocol version the server doesn't support, now say `MCP server "bart.example.com" …` rather than `MCP server "__ephemeral__" …`. A caller that passes `serverId` keeps it.
