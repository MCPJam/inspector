/**
 * A generated MCP server with many tools (202 by default), for tests of
 * reads that must stay bounded: tool names sort and read in order, each has a
 * description and one required string parameter, and every call is counted.
 * Over HTTP it runs in this process, like the ticket server beside it.
 */
import { serve } from "@hono/node-server";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

export const MANY_TOOLS = 202;

export interface GeneratedTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: { query: { type: "string"; description: string } };
    required: ["query"];
  };
}

/** `tool_001` .. `tool_<count>`: the last one is easy to name and hard to page to. */
export function generateTools(count = MANY_TOOLS): GeneratedTool[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `tool_${String(i + 1).padStart(3, "0")}`,
    description: `Tool number ${i + 1}. ${"It does one thing well and says so at length. ".repeat(4)}`,
    inputSchema: {
      type: "object" as const,
      properties: { query: { type: "string" as const, description: `Query for tool ${i + 1}` } },
      required: ["query"] as ["query"],
    },
  }));
}

export interface RunningManyToolsServer {
  url: string;
  tools: GeneratedTool[];
  /** Names of the tools called, in order. */
  calls: string[];
  close(): Promise<void>;
}

export async function startManyToolsHttp(count = MANY_TOOLS): Promise<RunningManyToolsServer> {
  const tools = generateTools(count);
  const calls: string[] = [];
  const build = () => {
    const server = new McpServer({ name: "many-tools-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
    for (const tool of tools) {
      server.registerTool(tool.name, { description: tool.description, inputSchema: { query: z.string() } }, async ({ query }) => {
        calls.push(tool.name);
        return { content: [{ type: "text" as const, text: `${tool.name}: ${query}` }] };
      });
    }
    return server;
  };
  const handler = createMcpHandler(build, { legacy: "stateless" });
  const http = serve({ fetch: (request) => handler.fetch(request), port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => http.once("listening", () => resolve()));
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    tools,
    calls,
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  };
}
