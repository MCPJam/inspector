# MCP Client Manager

`MCPClientManager` is a utility for managing multiple MCP clients built on top of `@modelcontextprotocol/sdk`. The manager wraps the `MCPClient` to manage any number of servers with any transport (stdio or HTTP/SSE), takes care of the connection lifecycle, and exposes helperes for tools, resources, prompts, and elicitation.

### Popular use cases

The MCPClientManager is a valuable utility to build any MCP Client.

- Build agents that connect to MCP servers. Use the `MCPClientManager` to connect to the MCP server (or multiple) and expose the tools for the agent. Compatible with popular libraries like Vercel AI SDK and Mastra.
- Create an LLM chat application with MCP support.
- Write unit tests or E2E tests for your MCP server.

`MCPClientManager` is also used as the foundation of the [MCPJam inspector](https://github.com/MCPJam/inspector)

## Installation

Install the MPCJam SDK:

```sh
npm install @mcpjam/sdk
```

# Constructor

Create a new instance of the `MCPClientManager` class. You can initiate the class with MCP server configs, and additional options. Server IDs must be unique.

```ts
type MCPServerConfig = StdioServerConfig | HttpServerConfig;
export type MCPClientManagerConfig = Record<string, MCPServerConfig>; // Server ID paired with the config

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

const mcpClientManager = new MCPClientManager({
  stdio_example: {
    command: "npx",
    args: ["-y @modelcontextprotocol/server-everything"],
    env: { arg_1: "abc" },
  },
  http_example: {
    url: new URL("http://localhost:3000/mcp"),
  },
});
```

Note that `MCPClientManager` figures out the transport (stdio vs HTTP/SSE) for you based on the server config provided.

### STDIO server

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

### Request Headers (Bearer Tokens)

Pass in headers in the connection to `requestInit`. This is where you would set up your bearer token.

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

# Capabilities

`MCPClientManager` has many methods to to interact with connected MCP servers and handle the connection lifecycle.

### `connectToServer(serverId: string, config: MCPServerConfig)`

You can connect to a new MCP server even after you've initialized connections in the constructor. The new connection is saved into the object state. The method returns a `Client`. Note that all serverIds must be unique.

```ts
import { MCPClientManager } from "@mcpjam/sdk";

const mcpClientManager = new MCPClientManager({
  everything: {
    command: "npx",
    args: ["-y @modelcontextprotocol/server-everything"],
  },
});

await mcpClientManager.connectToServer("file_system", {
  command: "npx",
  args: ["-y @modelcontextprotocol/file-system"],
});

console.log(mcpClientManager.listServers()); // ["everything", "file_system"]
```

### `disconnectServer(serverId: string)`

Disconnect from MCP server. Closes the connection and removes it from the client manager.

```ts
import { MCPClientManager } from "@mcpjam/sdk";

const mcpClientManager = new MCPClientManager({
  everything: {
    command: "npx",
    args: ["-y @modelcontextprotocol/server-everything"],
  },
});

await mcpClientManager.disconnectServer("everything");
console.log(mcpClientManager.listServers()); // []
```

### `getTools(serverIds?: string[])`

List all available tools in a single server or multiple servers. Pass in an array of serverIds. If multiple ids are passed in, then the function will return a flattened list of the tools.

```ts
mcpClientManager.getTools(["everything", "asana"]): Promise<ListToolsResult>
```

### `executeTool(serverId: string, toolName: string, args: {}, options?: RequestOptions)`

Execute a server's tools. Must pass in the serverId and the tool you want to call

```ts
mcpClientManager.executeTool("everything", "add", { a: 4, b: 5 }): ToolResult
```

### `pingServer(serverId: string, options?: RequestOptions)`

Ping a server.

```ts
mcpClientManager.pingServer("everything"): void
```

### `listTools(serverId: string, params?, options?)`

List tools for a single server. Caches tool metadata; returns empty if unsupported.

```ts
mcpClientManager.listTools("everything"): Promise<ListToolsResult>
```

### `getAllToolsMetadata(serverId: string)`

Return `_meta` for each tool keyed by tool name. This is useful for building an MCP client that supports OpenAI's Apps SDK.

```ts
mcpClientManager.getAllToolsMetadata("everything"); // => Record<string, any>
```

### `listResources(serverId: string, params?, options?)`

List server resources. Returns empty if unsupported.

```ts
mcpClientManager.listResources("everything");
```

### `readResource(serverId: string, params, options?)`

Read a resource by URI.

```ts
mcpClientManager.readResource("everything", { uri: "file:///README.md" });
```

### `subscribeResource(serverId: string, params, options?)`

Subscribe to resource updates.

```ts
mcpClientManager.subscribeResource("everything", { uri: "file:///README.md" });
```

### `unsubscribeResource(serverId: string, params, options?)`

Unsubscribe from a resource.

```ts
mcpClientManager.unsubscribeResource("everything", {
  uri: "file:///README.md",
});
```

### `listResourceTemplates(serverId: string, params?, options?)`

List resource templates.

```ts
mcpClientManager.listResourceTemplates("everything");
```

### `listPrompts(serverId: string, params?, options?)`

List all prompts

```ts
mcpClientManager.listPrompts("everything");
```

### `getPrompt(serverId: string, params, options?)`

Get a prompt by name with optional arguments.

```ts
mcpClientManager.getPrompt("everything", { name: "help", arguments: {} });
```

### `onResourceListChanged(serverId: string, handler)`

Handle resource list change notifications.

```ts
mcpClientManager.onResourceListChanged("everything", (n) => {
  /* ... */
});
```

### `onResourceUpdated(serverId: string, handler)`

Handle resource update notifications.

```ts
mcpClientManager.onResourceUpdated("everything", (n) => {
  /* ... */
});
```

### `onPromptListChanged(serverId: string, handler)`

Handle prompt list change notifications.

```ts
mcpClientManager.onPromptListChanged("everything", (n) => {
  /* ... */
});
```

### `setElicitationHandler(serverId: string, handler)`

Set a per-server handler for `elicitation/create` requests.

```ts
mcpClientManager.setElicitationHandler("everything", async (params) => ({
  content: "ok",
}));
```

### `clearElicitationHandler(serverId: string)`

Remove the per-server elicitation handler.

```ts
mcpClientManager.clearElicitationHandler("everything");
```

### `setElicitationCallback(callback)`

Set a global elicitation callback (used if no server-specific handler).

```ts
mcpClientManager.setElicitationCallback(
  async ({ requestId, message, schema }) => ({ content: message }),
);
```

### `clearElicitationCallback()`

Clear the global elicitation callback.

```ts
mcpClientManager.clearElicitationCallback();
```

### `getPendingElicitations()`

Get map of pending elicitation resolvers.

```ts
mcpClientManager.getPendingElicitations();
```

### `respondToElicitation(requestId: string, response)`

Resolve a pending elicitation by `requestId`. Returns `true` if handled.

```ts
mcpClientManager.respondToElicitation("elicit_123", { content: "done" });
```

### `disconnectAllServers()`

Disconnect all servers and clear state.

```ts
await mcpClientManager.disconnectAllServers();
```

# Support for popular agent libraries

## Vercel AI SDK

You can use the `getToolsForAiSdk` method to get tools in the format of Vercel AI SDK. The tools can then be passed into AI SDK for use.

```
getToolsForAiSdk(serverIds?: string[] | string, options?)
```

```ts
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';

const mcpClientManager = new MCPClientManager(
  ...
);

const response = await generateText({
  model: openai('gpt-4o-mini'),
  tools: mcpClientManager.getToolsForAiSdk(),
  messages: [{ role: 'user', content: 'Echo hi' }],
});
```

## Other support

We are capable of converting tools for any library. We currently have support for ai-sdk, but we're open to conversions for other libraries. Please consider contributing to the project to make this happen!

Join our [Discord channel](https://discord.com/invite/JEnDtz8X6z) for updates!
