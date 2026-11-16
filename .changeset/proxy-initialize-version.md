---
"@mcpjam/inspector": patch
---

MCPJam's MCP proxies now answer `initialize` in the protocol version the client asked for. A client on 2025-11-25 keeps working when the server behind the proxy speaks 2026-07-28; before, GitHub Copilot CLI switched to 2026 requests and never listed the server's tools.
