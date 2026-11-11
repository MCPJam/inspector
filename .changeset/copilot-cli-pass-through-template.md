---
"@mcpjam/sdk": patch
---

The GitHub Copilot CLI host template no longer pins MCPJam's client identity, the 2025-11-25 protocol or a 10 second request timeout, and it lists App-only tools as the CLI does. Its MCP connections now match the CLI's own handshake, so its calls can pass through to your server unchanged.
