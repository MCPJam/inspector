---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
"@mcpjam/cli": patch
---

Tool calls, resource reads and prompts now work on a server whose saved URL redirects to its endpoint, such as `https://mcp.excalidraw.com/` answering `308 → /mcp`. Since 3.17.0 they failed with "Error POSTing to endpoint (HTTP 308)" even though the server connected and listed fine, which also stopped MCP Apps from rendering. A redirect to a different origin, or a 301/302 that would turn the call into a GET, is still refused, and the error now names the URL to use instead.
