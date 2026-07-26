---
"@mcpjam/sdk": minor
---

Enable automatic MCP protocol negotiation for unpinned HTTP connections. MCPJam now probes `server/discover` for modern servers and conservatively falls back to the legacy `initialize` handshake, while explicit protocol pins and stdio connections retain their existing behavior. Inspector server configuration also keeps optional canonical OAuth protocol intent separately from the concrete version resolved for callback recovery.
