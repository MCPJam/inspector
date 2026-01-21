/**
 * Mock MCP Server for testing
 *
 * Can be run as:
 * - STDIO: `npx ts-node mock-mcp-server.ts`
 * - HTTP: `npx ts-node mock-mcp-server.ts --http --port 3456`
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import http from "http";

// Mock data
const MOCK_TOOLS = [
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

const MOCK_RESOURCES = [
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

const MOCK_PROMPTS = [
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

function createMockServer(): Server {
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
            { type: "text", text: `Echo: ${(args as any)?.message ?? ""}` },
          ],
        };

      case "add": {
        const a = Number((args as any)?.a ?? 0);
        const b = Number((args as any)?.b ?? 0);
        return {
          content: [{ type: "text", text: `Result: ${a + b}` }],
        };
      }

      case "greet":
        return {
          content: [
            { type: "text", text: `Hello, ${(args as any)?.name ?? "World"}!` },
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
            role: "user",
            content: { type: "text", text: "This is a simple prompt message" },
          },
        ],
      };
    } else if (name === "greeting_prompt") {
      const greetName = args?.name ?? "World";
      return {
        description: "A greeting prompt",
        messages: [
          {
            role: "user",
            content: { type: "text", text: `Please greet ${greetName}` },
          },
        ],
      };
    }

    throw new Error(`Prompt not found: ${name}`);
  });

  return server;
}

async function runStdioServer() {
  const server = createMockServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server runs until stdin closes
}

async function runHttpServer(port: number) {
  const { StreamableHTTPServerTransport } =
    await import("@modelcontextprotocol/sdk/server/streamableHttp.js");

  const server = createMockServer();

  const httpServer = http.createServer(async (req, res) => {
    // Handle CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === "/mcp" && req.method === "POST") {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => `session-${Date.now()}`,
      });

      // Handle the request
      await transport.handleRequest(req, res, await server.connect(transport));
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  httpServer.listen(port, () => {
    console.log(`Mock MCP HTTP server listening on port ${port}`);
  });

  return httpServer;
}

// Main entry point
const args = process.argv.slice(2);
const isHttp = args.includes("--http");
const portIndex = args.indexOf("--port");
const port = portIndex !== -1 ? parseInt(args[portIndex + 1], 10) : 3456;

if (isHttp) {
  runHttpServer(port);
} else {
  runStdioServer();
}

export { createMockServer, MOCK_TOOLS, MOCK_RESOURCES, MOCK_PROMPTS };
