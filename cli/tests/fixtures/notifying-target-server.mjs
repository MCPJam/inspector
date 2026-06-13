// Minimal stdio MCP server used as the target under test for `mcpjam mcp`
// tests: one echoing tool that emits a log notification, one resource, and
// one prompt.
import { McpServer, StdioServerTransport } from "@modelcontextprotocol/server";
import { z } from "zod";

const server = new McpServer(
  { name: "notifying-target", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} } },
);

server.registerTool(
  "echo",
  {
    description: "Echoes the provided text and emits a log notification.",
    inputSchema: z.object({
      text: z.string().describe("Text to echo"),
    }),
  },
  async ({ text }) => {
    await server.server.notification({
      method: "notifications/message",
      params: { level: "info", data: `echoed: ${text}` },
    });
    return {
      content: [{ type: "text", text: `echo: ${text}` }],
    };
  },
);

server.registerResource(
  "greeting",
  "demo://greeting",
  {
    title: "Greeting",
    description: "A static greeting resource.",
    mimeType: "text/plain",
  },
  async () => ({
    contents: [
      {
        uri: "demo://greeting",
        mimeType: "text/plain",
        text: "hello from the target server",
      },
    ],
  }),
);

server.registerPrompt(
  "greet",
  {
    description: "Greets someone by name.",
    argsSchema: z.object({
      name: z.string().describe("Who to greet"),
    }),
  },
  async ({ name }) => ({
    messages: [
      {
        role: "user",
        content: { type: "text", text: `Say hello to ${name}.` },
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());
