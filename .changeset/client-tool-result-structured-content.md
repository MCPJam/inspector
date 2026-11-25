---
"@mcpjam/inspector": patch
---

The client editor's Behavior tab now has a "Tool results sent to the model" setting, so any existing or custom client can choose which parts of an MCP tool result reach the model: combined JSON (the default, unchanged), prefer text (like Claude Desktop), prefer structured content (like Claude Code and Codex CLI), or text and structured content once each. Changing it keeps the client's image settings. The setting is hidden on harness clients, whose CLI applies its own.
