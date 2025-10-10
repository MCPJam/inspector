# MCP Client Manager

Utilities for managing multiple Model Context Protocol (MCP) clients built on top of `@modelcontextprotocol/sdk`.

This class wraps the MCP SDK `Client` and transports to manage any number of servers (stdio or HTTP/SSE), takes care of connection lifecycle, dispatches notifications, and exposes convenience helpers for tools, resources, and prompts.

## Installation

Install SDK peer dependency (required):

```sh
npm install @modelcontextprotocol/sdk
```

If you consume this as a local package inside a monorepo, adjust the import path to your setup. The examples below assume direct import from this package entry.

## Quickstart

```ts
import { MCPClientManager } from "./index"; // replace with your package name if published

// Create a manager with optional default capabilities/version/timeout
const manager = new MCPClientManager(
  {
    // STDIO server example
    local: {
      command: "node",
      args: ["server.js"],
      env: { NODE_ENV: "production" },
      timeout: 10_000,
      onError: (err) => console.error("[local]", err),
    },
    // HTTP server example (Streamable HTTP preferred, auto-fallback to SSE)
    httpDemo: {
      url: new URL("http://localhost:3001/mcp"),
      preferSSE: false, // try streamable first; falls back to SSE automatically
      timeout: 8_000,
    },
  },
  {
    defaultClientVersion: "1.0.0",
    defaultCapabilities: {
      // You can declare any capabilities you want to advertise to servers
      resources: {},
      tools: {},
      prompts: {},
      // Elicitation capability is auto-enabled if missing
    },
    defaultTimeout: 15_000,
  },
);

// Optionally connect explicitly (constructor schedules background connects)
await manager.connectToServer("local", {
  command: "node",
  args: ["server.js"],
});

// List tools for a specific server
const tools = await manager.listTools("local");
console.log(tools.tools.map((t) => t.name));

// Execute a tool on a server
const result = await manager.executeTool("local", "search", {
  query: "hello world",
});
console.log(result);
```

---

## API Reference with Examples

All methods below use the server name you registered under when constructing or connecting the manager.

### Constructor

```ts
new MCPClientManager(servers?: MCPClientManagerConfig, options?: {
  defaultClientVersion?: string;
  defaultCapabilities?: NonNullable<ClientOptions['capabilities']>;
  defaultTimeout?: number;
})
```

- **servers**: optional initial set of servers to register and connect lazily.
  - STDIO config:
    ```ts
    {
      command: string;
      args?: string[];
      env?: Record<string, string>;
      timeout?: number;
      version?: string;
      onError?: (error: unknown) => void;
    }
    ```
  - HTTP/Streamable/SSE config:
    ```ts
    {
      url: URL;
      requestInit?: RequestInit;            // for HTTP fetch
      eventSourceInit?: EventSourceInit;    // for SSE
      authProvider?: () => Promise<string>; // bearer token factory for HTTP
      reconnectionOptions?: { ... };
      sessionId?: string;                   // reuse session for Streamable HTTP
      preferSSE?: boolean;                  // default: auto based on URL or false
      timeout?: number;
      version?: string;
      onError?: (error: unknown) => void;
    }
    ```

Notes:

- If `preferSSE` is false (default), the manager tries Streamable HTTP first (short 3s connect timeout), then falls back to SSE.
- The elicitation capability is automatically enabled if not specified in capabilities.

### listServers()

```ts
const names = manager.listServers();
```

### hasServer(name)

```ts
const exists = manager.hasServer("local");
```

### connectToServer(name, config)

Connects (or reuses in-flight promise / existing connection) and returns the underlying SDK `Client`.

```ts
await manager.connectToServer("local", {
  command: "node",
  args: ["server.js"],
});

await manager.connectToServer("httpDemo", {
  url: new URL("http://localhost:3001/mcp"),
  preferSSE: false,
});
```

### disconnectServer(name)

```ts
await manager.disconnectServer("local");
```

### disconnectAllServers()

```ts
await manager.disconnectAllServers();
```

### listTools(name, params?, options?)

```ts
const { tools } = await manager.listTools("local");
```

### getTools(names?)

Returns a flattened list of tools across all or specific servers.

```ts
const all = await manager.getTools();
const some = await manager.getTools(["local", "httpDemo"]);
```

### executeTool(name, toolName, args?, options?)

```ts
const res = await manager.executeTool("local", "search", { query: "docs" });
```

### listResources(name, params?, options?)

```ts
const { resources } = await manager.listResources("local");
```

### readResource(name, params, options?)

```ts
const resource = await manager.readResource("local", {
  uri: "file://README.md",
});
```

### subscribeResource(name, params, options?) and unsubscribeResource(name, params, options?)

```ts
await manager.subscribeResource("local", { uri: "file://log.txt" });
// ... later
await manager.unsubscribeResource("local", { uri: "file://log.txt" });
```

### listResourceTemplates(name, params?, options?)

```ts
const { resourceTemplates } = await manager.listResourceTemplates("local");
```

### listPrompts(name, params?, options?)

```ts
const { prompts } = await manager.listPrompts("local");
```

### getPrompt(name, params, options?)

```ts
const prompt = await manager.getPrompt("local", { name: "summarize" });
```

### getSessionIdByServer(name)

Only valid for Streamable HTTP transports; throws for STDIO/SSE.

```ts
const sessionId = manager.getSessionIdByServer("httpDemo");
```

### Notifications

Use convenience helpers or register for any schema explicitly.

```ts
import {
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  PromptListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types";

// Convenience helpers
manager.onResourceListChanged("local", (n) => {
  console.log("resource list changed", n);
});
manager.onResourceUpdated("local", (n) => {
  console.log("resource updated", n);
});
manager.onPromptListChanged("local", (n) => {
  console.log("prompt list changed", n);
});

// Generic registration
manager.addNotificationHandler(
  "local",
  ResourceListChangedNotificationSchema,
  (n) => {
    console.log("generic resource list handler", n);
  },
);
```

### Elicitation

Provide a handler to respond to `elicitation/create` requests from the server.

```ts
manager.setElicitationHandler("local", async (params) => {
  // params: ElicitRequest['params']
  // Return ElicitResult
  return {
    content: [{ type: "text", text: `You asked: ${JSON.stringify(params)}` }],
  };
});

// To remove the handler
manager.clearElicitationHandler("local");
```

### Accessing the underlying Client

```ts
const client = manager.getClient("local");
if (client) {
  // use Client directly if needed
}
```

### Per-call timeouts and defaults

All request methods accept `options?: { timeout?: number }`. If omitted, the manager uses:

- the server-specific `timeout` if set in its config, otherwise
- the `defaultTimeout` passed to the constructor, otherwise
- the SDK default.

```ts
await manager.executeTool("local", "slowTask", {}, { timeout: 20_000 });
```

### Error handling

- Each server config can supply `onError` to observe client-level errors.
- All notification handlers are isolated; a thrown error in one handler won’t break others.
- If a transport closes, the manager clears the state for that server; subsequent calls will attempt reconnect via `ensureConnected`.

---

## Build

```sh
npm install
npm run build
```

The build step emits ESM, CJS, and type declaration artifacts to `dist/` ready for publishing to npm.
