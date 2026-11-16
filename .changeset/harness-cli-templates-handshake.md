---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

New clients from the Claude Code, Codex CLI, Cursor CLI and GitHub Copilot CLI templates start with Tool Approval on and present their CLI's own MCP handshake (client name, version and capabilities). Where a turn doesn't forward, MCPJam's client shows the server that same identity. A GitHub Copilot CLI client's handshake no longer keeps it from native forwarding where that opens. A new OpenCode template appears for organizations with OpenCode enabled. Saved clients keep their settings.
