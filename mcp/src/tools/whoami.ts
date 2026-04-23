import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpJamMcpServer } from "../server.js";
import { fetchMcpWhoAmI } from "../convexBridge.js";

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
      const { userId, user } = await fetchMcpWhoAmI(
        agent.runtimeEnv.CONVEX_HTTP_URL,
        token
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ id: userId, user }, null, 2),
          },
        ],
      };
    }
  );
}

function toolError(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}
