import { Hono } from "hono";
import "../../types/hono"; // Type extensions
import { logger } from "../../utils/logger";
import { listResources, readResource } from "../../utils/route-handlers.js";
import {
  toServedFromCache,
  withCacheEventCapture,
} from "../../utils/cache-events.js";

const resources = new Hono();

// List resources endpoint
resources.post("/list", async (c) => {
  let serverId: string | undefined;
  try {
    const body = (await c.req.json()) as {
      serverId?: string;
      cursor?: string;
      refresh?: boolean;
    };
    serverId = body.serverId;
    if (!serverId) {
      return c.json({ success: false, error: "serverId is required" }, 400);
    }
    const { result, events } = await withCacheEventCapture(() =>
      listResources(c.mcpClientManager, {
        serverId: serverId!,
        cursor: body.cursor,
        cacheMode: body.refresh ? "refresh" : undefined,
      }),
    );
    const servedFromCache = toServedFromCache(events);
    return c.json({
      ...result,
      ...(servedFromCache ? { servedFromCache } : {}),
    });
  } catch (error) {
    logger.error("Error fetching resources", error, { serverId });
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// Read resource endpoint
resources.post("/read", async (c) => {
  let serverId: string | undefined;
  let uri: string | undefined;
  try {
    const body = (await c.req.json()) as {
      serverId?: string;
      uri?: string;
      refresh?: boolean;
    };
    serverId = body.serverId;
    uri = body.uri;
    if (!serverId) {
      return c.json({ success: false, error: "serverId is required" }, 400);
    }
    if (!uri) {
      return c.json({ success: false, error: "Resource URI is required" }, 400);
    }
    const { result, events } = await withCacheEventCapture(() =>
      readResource(c.mcpClientManager, {
        serverId: serverId!,
        uri: uri!,
        cacheMode: body.refresh ? "refresh" : undefined,
      }),
    );
    const servedFromCache = toServedFromCache(events);
    return c.json({
      ...result,
      ...(servedFromCache ? { servedFromCache } : {}),
    });
  } catch (error) {
    logger.error("Error reading resource", error, { serverId, uri });
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

export default resources;
