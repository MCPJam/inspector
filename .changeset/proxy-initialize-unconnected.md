---
"@mcpjam/inspector": patch
---

MCPJam's MCP proxies answer `initialize` in the protocol version the client asked for even before the server behind them has connected, instead of always answering 2025-06-18.
