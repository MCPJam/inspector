/**
 * Test utilities for mock MCP servers
 */

import http from "http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Server as HttpServer } from "http";
import type { AddressInfo } from "net";

// Mock data
export const MOCK_TOOLS = [
  {
    name: "echo",
    description: "Echoes back the input message",
    inputSchema: {
      type: "object" as const,
      properties: {
        message: { type: "string", description: "Message to echo" },
      },
      required: ["message"],
    },
  },
  {
    name: "add",
    description: "Adds two numbers",
    inputSchema: {
      type: "object" as const,
      properties: {
        a: { type: "number", description: "First number" },
        b: { type: "number", description: "Second number" },
      },
      required: ["a", "b"],
    },
  },
  {
    name: "greet",
    description: "Greets a person by name",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Name to greet" },
      },
      required: ["name"],
    },
  },
];

export const MOCK_RESOURCES = [
  {
    uri: "test://resource/1",
    name: "Test Resource 1",
    description: "A test resource",
    mimeType: "text/plain",
  },
  {
    uri: "test://resource/2",
    name: "Test Resource 2",
    description: "Another test resource",
    mimeType: "application/json",
  },
];

export const MOCK_PROMPTS = [
  {
    name: "simple_prompt",
    description: "A simple test prompt",
    arguments: [],
  },
  {
    name: "greeting_prompt",
    description: "A greeting prompt with arguments",
    arguments: [{ name: "name", description: "Name to greet", required: true }],
  },
];

/**
 * Creates a mock MCP server with predefined tools, resources, and prompts
 */
export function createMockServer(): Server {
  const server = new Server(
    {
      name: "mock-mcp-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    }
  );

  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: MOCK_TOOLS };
  });

  // Call tool
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "echo":
        return {
          content: [
            {
              type: "text" as const,
              text: `Echo: ${(args as Record<string, unknown>)?.message ?? ""}`,
            },
          ],
        };

      case "add": {
        const a = Number((args as Record<string, unknown>)?.a ?? 0);
        const b = Number((args as Record<string, unknown>)?.b ?? 0);
        return {
          content: [{ type: "text" as const, text: `Result: ${a + b}` }],
        };
      }

      case "greet":
        return {
          content: [
            {
              type: "text" as const,
              text: `Hello, ${(args as Record<string, unknown>)?.name ?? "World"}!`,
            },
          ],
        };

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  // List resources
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return { resources: MOCK_RESOURCES };
  });

  // Read resource
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    if (uri === "test://resource/1") {
      return {
        contents: [
          {
            uri,
            mimeType: "text/plain",
            text: "This is the content of test resource 1",
          },
        ],
      };
    } else if (uri === "test://resource/2") {
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify({ key: "value", count: 42 }),
          },
        ],
      };
    }

    throw new Error(`Resource not found: ${uri}`);
  });

  // List prompts
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return { prompts: MOCK_PROMPTS };
  });

  // Get prompt
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === "simple_prompt") {
      return {
        description: "A simple test prompt",
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: "This is a simple prompt message",
            },
          },
        ],
      };
    } else if (name === "greeting_prompt") {
      const greetName = args?.name ?? "World";
      return {
        description: "A greeting prompt",
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Please greet ${greetName}`,
            },
          },
        ],
      };
    }

    throw new Error(`Prompt not found: ${name}`);
  });

  return server;
}

/**
 * Starts a mock HTTP MCP server
 * Returns the server instance and the URL to connect to
 */
export async function startMockHttpServer(
  port = 0
): Promise<{ server: HttpServer; url: string; stop: () => Promise<void> }> {
  const mcpServer = createMockServer();
  let sseTransport: InstanceType<typeof SSEServerTransport> | null = null;

  const httpServer = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization"
    );

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // SSE endpoint
    if (req.url === "/sse" || req.url === "/sse/") {
      sseTransport = new SSEServerTransport("/message", res);
      await mcpServer.connect(sseTransport);
      return;
    }

    // Message endpoint for SSE
    if (req.url?.startsWith("/message") && req.method === "POST") {
      if (!sseTransport) {
        res.writeHead(400);
        res.end("No SSE connection established");
        return;
      }

      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", async () => {
        const activeTransport = sseTransport;
        if (!activeTransport) {
          res.writeHead(400);
          res.end("No SSE connection established");
          return;
        }
        try {
          await activeTransport.handlePostMessage(req, res, body);
        } catch (error) {
          res.writeHead(500);
          res.end(String(error));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  return new Promise((resolve) => {
    httpServer.listen(port, "127.0.0.1", () => {
      const address = httpServer.address() as AddressInfo;
      const url = `http://127.0.0.1:${address.port}/sse`;

      resolve({
        server: httpServer,
        url,
        stop: () =>
          new Promise<void>((resolveStop) => {
            httpServer.close(() => resolveStop());
          }),
      });
    });
  });
}

/**
 * Starts a mock Streamable HTTP MCP server
 * Returns the server instance and the URL to connect to
 */
export async function startMockStreamableHttpServer(
  port = 0
): Promise<{ server: HttpServer; url: string; stop: () => Promise<void> }> {
  const mcpServer = createMockServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => `session-${Date.now()}`,
  });
  await mcpServer.connect(transport);

  const httpServer = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization"
    );

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === "/mcp") {
      await transport.handleRequest(req, res);
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  return new Promise((resolve) => {
    httpServer.listen(port, "127.0.0.1", () => {
      const address = httpServer.address() as AddressInfo;
      const url = `http://127.0.0.1:${address.port}/mcp`;

      resolve({
        server: httpServer,
        url,
        stop: () =>
          new Promise<void>((resolveStop) => {
            httpServer.close(() => resolveStop());
          }),
      });
    });
  });
}

/**
 * STDIO server configuration for testing
 * Uses ts-node to run the mock server
 */
export function getStdioServerConfig() {
  return {
    command: "npx",
    args: ["ts-node", "--esm", `${__dirname}/mock-mcp-server.ts`],
  };
}
