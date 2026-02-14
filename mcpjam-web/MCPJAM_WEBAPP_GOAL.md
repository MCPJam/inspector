# Objective 

We want to build a lightweight web app version of MCPJam, no Hono server, full client app. Because it's going to be hosted, we can only connect to remote Streamable HTTP MCP servers. That means no STDIO or localhost enabled. This project must be very barebones and minimalist. 

# Features
We will only have the server connections page and the LLM playground page. 

1. Server connections page to manage server connections. 
2. Be able to also connect to MCP servers that have Dynamic Client Registration 
3. LLM playground to chat with the MCP server with different models 
4. Same UI theme as the MCPJam inspector. 

Eventually the LLM playground should have full parity to handle ChatGPT apps rendering and MCP apps rendering. For now, we can start off with basic MCP server chatting. 

# Suggested instructions 
- Create a global hook that manages the MCP connections. Use the `MCPClientManager` class from @mcpjam/sdk
- Have this hook expose some functions such as connect / disconnect MCP servers. 
- Use Vercel AI-SDK to manage text streaming. 

## Instructions for AI: Feel free to write more planning below here.


## Personal note on CORS pre-flight 
Web app path (fails): browser uses @mcpjam/sdk/browser directly in McpConnectionsProvider.tsx (line 1) and calls manager.connectToServer(...) at McpConnectionsProvider.tsx (line 246).
Inspector path (works): browser posts config to local API (/api/mcp/connect) at mcp-api.ts (line 37), then backend calls mcpClientManager.connectToServer(...) at connect.ts (line 71), with manager created on the Node server in app.ts (line 86).
Why that matters:

Browser direct calls hit CORS/preflight rules.
For https://excalidraw-mcp-app.vercel.app/mcp, OPTIONS returns 405, so streamable fetch fails in browser (Failed to fetch).
Then SDK fallback tries SSE GET, and that endpoint returns 405, producing your SSE error.
Node backend (inspector) is not blocked by browser CORS preflight, so it can do the valid streamable POST and connect.
Extra proof from inspector design:

It also exposes its own bridge endpoints with explicit OPTIONS 204 for browser clients in http-adapters.ts (line 21).
So the behavior difference is expected: direct browser transport vs backend-proxied transport.