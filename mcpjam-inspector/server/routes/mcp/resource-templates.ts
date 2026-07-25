import { Hono } from "hono";
import "../../types/hono"; // Type extensions
import { logger } from "../../utils/logger";

const resourceTemplates = new Hono();

// List resource templates endpoint
resourceTemplates.post("/list", async (c) => {
  let serverId: string | undefined;
  try {
    const body = (await c.req.json()) as {
      serverId?: string;
      cursor?: string;
    };
    serverId = body.serverId;

    if (!serverId) {
      return c.json({ success: false, error: "serverId is required" }, 400);
    }
    const mcpClientManager = c.mcpClientManager;
    // Cursor is optional — omitted, this returns the full aggregate (the
    // official beta.4 client auto-pages no-cursor list calls). Passing a
    // cursor returns exactly one raw page, matching the tools/resources
    // routes' cursor parity.
    const { resourceTemplates: templates, nextCursor } =
      await mcpClientManager.listResourceTemplates(
        serverId,
        body.cursor ? { cursor: body.cursor } : undefined,
      );
    return c.json({
      resourceTemplates: templates,
      ...(nextCursor ? { nextCursor } : {}),
    });
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
