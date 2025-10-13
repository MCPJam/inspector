# Objective

We want to create a object / class MCPClientManager object. It is built on top of the Client object in MCP. I want the behavior of MCPClientManager to be able to support all of the things that @mastra-reference-client.ts has, such as connecting to multiple MCP clients.

# Spec

I want to be able to configure servers by passing in a JSON like object on initiation, and have it figure out on its own whether its STDIO, or SSE/Streamable HTTP:

```
export const mcpClientManager = new MCPClientManager({
    stdio: {
      command: "npx",
      args: [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/Users/username/Downloads",
      ],
    },
    streamable: {
        url: new URL("http://localhost:4111/api/mcp/mcpServer/mcp"),
    },
});
```

# Functions that need to be built

- `disconnectAllServers()`: This disconnects all the clients and removes them from the state.
- `connectToServer(name: string, config: MCPServerConfig)`: this adds the config to the state AND connects to the server.
- `getTools(names?: string[])`: This returns an array of tools. This can either be all tools by leaving names empty, or pass in an array of string to get a subset of tools

```
{
    tools: [
        ...all tools
    ]
}
```

- `private getClientByName(name: string): Client`: This gets the client by name from state
- `executeTool()` This function should get the client by name, then execute the tool.

# Mastra MCPClient

Mastra built a similar MCPClient in @mastra-reference-client.ts. However, we should not have any Mastra logic. Have it be as close to the @modelcontextprotocol/sdk/client as possible.
