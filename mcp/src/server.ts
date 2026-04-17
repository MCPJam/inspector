import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ConvexHttpClient } from "convex/browser";
import type { JWTPayload } from "jose";

interface McpProps extends Record<string, unknown> {
  bearerToken: string;
  claims: JWTPayload;
}

export class McpJamMcpServer extends McpAgent<Env, unknown, McpProps> {
  server = new McpServer({
    name: "MCPJam MCP",
    version: "0.1.0",
  });

  async init(): Promise<void> {
    this.server.registerTool(
      "whoami",
      {
        title: "Who am I?",
        description:
          "Returns the authenticated MCPJam user's Convex record. Proves the AuthKit bearer token reached Convex.",
        inputSchema: {},
      },
      async () => {
        const token = this.props?.bearerToken;
        if (!token) {
          return {
            isError: true,
            content: [
              { type: "text", text: "No bearer token on the request." },
            ],
          };
        }

        const client = new ConvexHttpClient(this.env.CONVEX_URL);
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
      },
    );
  }
}
