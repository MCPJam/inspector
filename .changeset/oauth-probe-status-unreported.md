---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

The OAuth debugger no longer reports an MCP server's own bad reply to the first no-token request (a 500, 404, or bare 403) as an MCPJam error. The message still shows on screen. The SDK adds `isUnexpectedProbeStatus` to spot it.
