---
"@mcpjam/inspector": patch
---

`MCPJAM_PLATFORM_AGENT=off` turns Ask MCPJam off for a deployment that cannot reach MCPJam's own MCP servers: its routes answer `404 FEATURE_NOT_SUPPORTED` without dialling the platform worker or the docs servers, and the app hides the agent's entry points. Any other value keeps the agent.
