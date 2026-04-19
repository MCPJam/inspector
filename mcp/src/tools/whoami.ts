import { ConvexHttpClient } from "convex/browser";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpJamMcpServer } from "../server.js";
import { toolError } from "./shared.js";

export function registerWhoamiTool(
  server: McpServer,
  agent: McpJamMcpServer
): void {
  server.registerTool(
    "whoami",
    {
      title: "Who am I?",
      description:
        "Returns the authenticated MCPJam user's Convex record. Proves the AuthKit bearer token reached Convex.",
      inputSchema: z.object({}),
    },
    async () => {
      const token = agent.bearerToken;
      if (!token) {
        return toolError("No bearer token on the request.");
      }

      const client = new ConvexHttpClient(agent.runtimeEnv.CONVEX_URL);
      client.setAuth(token);

      const id = await client.mutation("users:ensureUser" as any, {});
      const user = await client.query("users:getCurrentUser" as any, {});

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ id, user }, null, 2),
          },
        ],
      };
    }
  );
}