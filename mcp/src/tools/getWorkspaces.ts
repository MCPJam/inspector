import { ConvexHttpClient } from "convex/browser";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpJamMcpServer } from "../server.js";

type RemoteWorkspace = {
  _id: string;
  name: string;
  description?: string;
  icon?: string;
  organizationId: string;
  ownerId: string;
  visibility?: string;
  createdAt: number;
  updatedAt: number;
};

export function registerGetWorkspacesTool(
  server: McpServer,
  agent: McpJamMcpServer
): void {
  server.registerTool(
    "getWorkspaces",
    {
      title: "List my MCPJam workspaces",
      description:
        "Returns the authenticated user's workspaces. Pass organizationId to filter to a single organization.",
      inputSchema: z.object({
        organizationId: z.string().min(1).optional(),
      }),
    },
    async ({ organizationId }) => {
      const token = agent.bearerToken;
      if (!token) {
        return toolError("No bearer token on the request.");
      }

      const client = new ConvexHttpClient(agent.runtimeEnv.CONVEX_URL);
      client.setAuth(token);

      const workspaces = (await client.query(
        "workspaces:getMyWorkspaces" as any,
        {}
      )) as RemoteWorkspace[];

      const filtered = organizationId
        ? workspaces.filter((w) => w.organizationId === organizationId)
        : workspaces;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(filtered, null, 2),
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
