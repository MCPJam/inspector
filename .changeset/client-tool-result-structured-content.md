---
"@mcpjam/inspector": patch
---

The client editor's Behavior tab now has a "Tool results sent to the model" setting, so any existing or custom client can choose which parts of an MCP tool result reach the model: all three (the text, structuredContent and \_meta as one escaped JSON string, the default and unchanged), the text, structuredContent, or both without \_meta. Changing it keeps the client's image settings. The setting is hidden on harness clients, whose CLI applies its own.
