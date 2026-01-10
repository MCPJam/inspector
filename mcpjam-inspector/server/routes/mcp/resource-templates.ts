import { Hono } from "hono";
import "../../types/hono"; // Type extensions
import { logger } from "../../utils/logger";

const resourceTemplates = new Hono();

// List resource templates endpoint
resourceTemplates.post("/list", async (c) => {
  try {
    const { serverId } = (await c.req.json()) as { serverId?: string };

    if (!serverId) {
      return c.json({ success: false, error: "serverId is required" }, 400);
    }
    const mcpClientManager = c.mcpClientManager;
    const { resourceTemplates: templates } =
      await mcpClientManager.listResourceTemplates(serverId);
    return c.json({ resourceTemplates: templates });
  } catch (error) {
    logger.error("Error fetching resource templates", error, { serverId });
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

export default resourceTemplates;
