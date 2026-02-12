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