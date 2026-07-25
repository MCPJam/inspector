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
      cursor?: string;
      refresh?: boolean;
    };
    serverId = body.serverId;
    const refresh = body.refresh;

    if (!serverId) {
      return c.json({ success: false, error: "serverId is required" }, 400);
    }
    const mcpClientManager = c.mcpClientManager;
    // Cursor is optional — omitted, this returns the full aggregate (the
    // official beta.4 client auto-pages no-cursor list calls). Passing a
    // cursor returns exactly one raw page, matching the tools/resources
    // routes' cursor parity.
    const { result, events } = await withCacheEventCapture(() =>
      mcpClientManager.listResourceTemplates(
        serverId!,
        body.cursor ? { cursor: body.cursor } : undefined,
        // Mirrors the SDK's `cacheOptions()` convention: omit the options
        // object entirely unless a refresh was actually requested.
        refresh === true ? { cacheMode: "refresh" as const } : undefined,
      ),
    );
    const servedFromCache = toServedFromCache(events);
    return c.json({
      resourceTemplates: result.resourceTemplates,
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
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
