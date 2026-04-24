import { ConvexHttpClient } from "convex/browser";
import { z } from "zod";
import { WHOAMI_APP_HTML } from "../generated/McpAppsHtml.bundled.js";
import type { WhoamiPayload } from "../shared/whoami.js";
import type { McpJamMcpServer } from "../server.js";
import type { SessionToolRegistrar } from "./sessionToolRegistrar.js";

export const WHOAMI_RESOURCE_URI = "ui://mcpjam/whoami.html";

export function registerWhoamiTool(
  registrar: SessionToolRegistrar,
  agent: McpJamMcpServer
): void {
  registrar.registerTool(
    "whoami",
    {
      title: "Who am I?",
      description:
        "Returns the authenticated MCPJam user's Convex record. Proves the AuthKit bearer token reached Convex.",
      inputSchema: z.object({}),
    },
    async () => {
      const payload = await getWhoamiPayload(agent);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    },
    {
      resourceUri: WHOAMI_RESOURCE_URI,
      html: WHOAMI_APP_HTML,
      resourceName: "MCPJam whoami UI",
      resourceMeta: {
        ui: {
          prefersBorder: true,
        },
      },
      callback: async () => {
        const payload = await getWhoamiPayload(agent);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(payload, null, 2),
            },
          ],
          structuredContent: payload,
        };
      },
    }
  );
}

export async function getWhoamiPayload(
  agent: McpJamMcpServer
): Promise<WhoamiPayload> {
  const token = agent.bearerToken;
  if (!token) {
    throw new Error("No bearer token on the request.");
  }

  const client = new ConvexHttpClient(agent.runtimeEnv.CONVEX_URL);
  client.setAuth(token);

  const id = (await client.mutation("users:ensureUser" as any, {})) as string;
  const user = await client.query("users:getCurrentUser" as any, {});

  return { id, user };
}
