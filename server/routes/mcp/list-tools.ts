import { Hono } from "hono";
import type { MCPClientManager } from "@/sdk";
import "../../types/hono";
import { logger } from "../../utils/logger";

const listTools = new Hono();

listTools.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const { serverIds } = body;

    if (!Array.isArray(serverIds) || serverIds.length === 0) {
      return c.json({ error: "serverIds must be a non-empty array" }, 400);
    }

    const clientManager = c.mcpClientManager;
    const allTools: Array<{
      name: string;
      description?: string;
      inputSchema?: any;
      serverId: string;
    }> = [];

    for (const serverId of serverIds) {
      // Check if server is connected
      if (
        clientManager.getConnectionStatusByAttemptingPing(serverId) !==
        "connected"
      ) {
        continue;
      }

      try {
        const { tools } = await clientManager.listTools(serverId);
        const serverTools = tools.map((tool: any) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          serverId,
        }));
        allTools.push(...serverTools);
      } catch (error) {
        logger.warn(`Failed to list tools for server ${serverId}`, {
          serverId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return c.json({ tools: allTools });
  } catch (error) {
    logger.error("Error in /list-tools", error);
    return c.json(
      {
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

export default listTools;
