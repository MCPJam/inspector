# MCP Client Manager

`MCPClientManager` is a utility for managing multiple MCP clients built on top of `@modelcontextprotocol/sdk`. The manager wraps the `MCPClient` to manage any number of servers with any transport (stdio or HTTP/SSE), takes care of the connection lifecycle, and exposes helperes for tools, resources, prompts, and elicitation. 

### Popular use cases
- Build agents that connect to MCP servers. Use the `MCPClientManager` to connect to the MCP server (or multiple) and expose the tools for the agent. 
- Create an LLM chat application with MCP support
- Write unit tests or E2E tests for your MCP server.

`MCPClientManager` is also used as the foundation of the [MCPJam inspector](https://github.com/MCPJam/inspector)

## Installation

Install the MPCJam SDK:

```sh
npm install @mcpjam/sdk
```

# Constructor

Create a new instance of the `MCPClientManager` class. You can initiate the class with MCP server configs, and additional options. 

```ts
type MCPServerConfig = StdioServerConfig | HttpServerConfig;

constructor(
  servers: MCPClientManagerConfig = {},
  options: {
    defaultClientVersion?: string;
    defaultCapabilities?: Record<string, MCPServerConfig>;
    defaultTimeout?: number;
  } = {},
)
```

## Basic example: 
```ts
import { MCPClientManager } from "@mcpjam/sdk";

const mcpClientManager = new MCPClientManager(
  {
    stdio_example: {
      command: "npx",
      args: ["-y @modelcontextprotocol/server-everything"],
      env: { arg_1: "abc" },
    },
    http_example: {
      url: new URL("http://localhost:3000/mcp"),
    },
  }
);
```

Note that `MCPClientManager` figures out the transport (stdio vs HTTP/SSE) for you based on the server config provided. 

### stdio server 
The structure of a stdio server connection is basic. Pass in a `command`, `args`, and optional environment variables. 

```ts
type BaseServerConfig = {
  capabilities?: ClientOptions["capabilities"];
  timeout?: number;
  version?: string;
  onError?: (error: unknown) => void;
};

type StdioServerConfig = BaseServerConfig & {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};
```

You can see the stdio server config example in the Basic example above. 

### HTTP/SSE server
Connections to HTTP/SSE has more configurations: 

```ts
import type { StreamableHTTPClientTransportOptions } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

type HttpServerConfig = BaseServerConfig & {
  url: URL;
  requestInit?: StreamableHTTPClientTransportOptions["requestInit"];
  eventSourceInit?: SSEClientTransportOptions["eventSourceInit"];
  authProvider?: StreamableHTTPClientTransportOptions["authProvider"];
  reconnectionOptions?: StreamableHTTPClientTransportOptions["reconnectionOptions"];
  sessionId?: StreamableHTTPClientTransportOptions["sessionId"];
  preferSSE?: boolean;
};
```

To connect to an MCP server with OAuth, pass in the bearer token to the Request Header: 

```ts
import { MCPClientManager } from "@mcpjam/sdk";

const mcpClientManager = new MCPClientManager(
  {
    asana: {
      url: new URL("https://mcp.asana.com/sse"),
      requestInit: {
        headers: {
          Authorization: "Bearer <BEARER_TOKEN>". 
        }
      }
    },
  }
);
```

# 