## Problem

I want to build a LLM chat client. I want the client to be ran locally, and the backend where the LLM agent lives is on a server seperately. 

Node.js client, Node.js server using Vercel ai-sdk in the backend. We also want to support MCP / tool calling. The MCPClient that does MCP server connections calls the tools lives on the client. 

The client should send messages to the server, along with the MCP tool schema. The agent on the backend will request a tool call when there is one, and send it back to the client. The client will execute the tool call, and send it back to the agent to continue the conversation. 

We are using Mastra MCPClient and ai-sdk on the backend 

## Corner cases 
https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling
https://mastra.ai/en/reference/tools/mcp-client





