---
"@mcpjam/inspector": patch
---

Swarms: setup no longer stops a target because of what the setup model wrote in its report. A target now stops only when setup can't create its test data, setup creates more test data than it can track, it times out, it can't reach the MCP server, or MCPJam couldn't run setup. When a target stops, its card is titled "Setup stopped this target" and says which of these happened, instead of "New error class the inspector hasn't been taught about yet".
