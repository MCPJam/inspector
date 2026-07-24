import { Hono } from "hono";
import "../../types/hono"; // Type extensions
import { logger } from "../../utils/logger";
import {
  toServedFromCache,
  withCacheEventCapture,
} from "../../utils/cache-events.js";

const resourceTemplates = new Hono();

// List resource templates endpoint
resourceTemplates.post("/list", async (c) => {
  let serverId: string | undefined;
  try {
    const body = (await c.req.json()) as {
      serverId?: string;
      refresh?: boolean;
    };
    serverId = body.serverId;
    const refresh = body.refresh;

    if (!serverId) {
      return c.json({ success: false, error: "serverId is required" }, 400);
    }
    const mcpClientManager = c.mcpClientManager;
    const { result, events } = await withCacheEventCapture(() =>
      mcpClientManager.listResourceTemplates(serverId!, undefined, {
        cacheMode: refresh ? "refresh" : undefined,
      }),
    );
    const servedFromCache = toServedFromCache(events);
    return c.json({
      resourceTemplates: result.resourceTemplates,
      ...(servedFromCache ? { servedFromCache } : {}),
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
