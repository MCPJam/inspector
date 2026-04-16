import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Register MCP tools on the given server instance.
 *
 * This is the extension seam: future PRs will add real MCPJam tooling here
 * (evals, diagnose_server, etc.) without touching the Worker entrypoint.
 */
export function registerTools(server: McpServer): void {
  server.registerTool(
    "hello_world",
    {
      title: "Hello World",
      description:
        "Returns a friendly greeting. Used to verify MCP connectivity.",
      inputSchema: {
        name: z
          .string()
          .optional()
          .describe("Who to greet. Defaults to 'world' if omitted or empty."),
      },
      outputSchema: {
        greeting: z.string(),
        target: z.string(),
      },
    },
    async ({ name }) => {
      const target = (name ?? "").trim() || "world";
      const greeting = `Hello, ${target}!`;
      return {
        content: [{ type: "text", text: greeting }],
        structuredContent: { greeting, target },
      };
    },
  );
}

/**
 * Durable Object-backed MCP server.
 *
 * Wrangler binds this class via the `MCP_OBJECT` durable object binding
 * declared in `wrangler.jsonc`.
 */
export class McpJamMcpServer extends McpAgent {
  server = new McpServer({
    name: "MCPJam MCP",
    version: "0.0.1",
  });

  async init(): Promise<void> {
    registerTools(this.server);
  }
}
