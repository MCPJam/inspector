---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
---

MCPJam now sends `MCPJam/<version> (+https://mcpjam.com) MCP-Inspector/1.0` as its User-Agent to MCP servers and OAuth servers, the same in the desktop app, `npx @mcpjam/inspector` and the hosted app. Local connections used to send `node`. A User-Agent set in a server's Headers still wins. The SDK adds `mcpjamUserAgent`, `getDefaultUserAgent` and `setDefaultUserAgent`.
