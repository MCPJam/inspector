---
"@mcpjam/inspector": patch
---

Every harness client's chat now keeps one MCP configuration for the whole conversation, with each message's access checked on MCPJam's side. GitHub Copilot CLI can now answer a paused tool approval after its box was kept warm, instead of asking you to send the message again. When a server's tools change between messages, the next message sees the new tools.
