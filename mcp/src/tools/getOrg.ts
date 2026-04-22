import { ConvexHttpClient } from "convex/browser";
import { z } from "zod";
import type { McpJamMcpServer } from "../server.js";
import type { SessionToolRegistrar } from "./sessionToolRegistrar.js";

type Organization = {
  _id: string;
  name: string;
  description?: string;
  imageUrl?: string;
  logoUrl?: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  myRole?: string;
};

export function registerGetOrgTool(
  server: SessionToolRegistrar,
  agent: McpJamMcpServer
): void {
  server.registerTool(
    "getOrg",
    {
      title: "Get one of my MCPJam organizations",
      description:
        "Returns the authenticated user's organization by ID. The ID must match an org the caller belongs to.",
      inputSchema: z.object({
        organizationId: z.string().min(1),
      }),
    },
    async ({ organizationId }) => {
      const token = agent.bearerToken;
      if (!token) {
        return toolError("No bearer token on the request.");
      }

      const client = new ConvexHttpClient(agent.runtimeEnv.CONVEX_URL);
      client.setAuth(token);

      const orgs = (await client.query(
        "organizations:getMyOrganizations" as any,
        {}
      )) as Organization[];

      const match = orgs.find((o) => o._id === organizationId);
      if (!match) {
        return toolError(
          `Organization ${organizationId} not found or not accessible.`
        );
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(match, null, 2),
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
