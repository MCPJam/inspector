---
"@mcpjam/inspector": patch
---

A GitHub Copilot CLI client with MCP servers no longer needs native forwarding. Where a turn can't forward, the CLI reaches its servers through MCPJam's MCP proxy instead of being refused. With Tool Approval on, the turn pauses before each MCP call until you allow or deny it.
