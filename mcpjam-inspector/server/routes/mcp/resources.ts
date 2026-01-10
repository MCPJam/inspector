import { Hono } from "hono";
import "../../types/hono"; // Type extensions
import { logger } from "../../utils/logger";

const resources = new Hono();

// In-memory storage for widget data (TTL: 1 hour)
interface WidgetData {
  serverId: string;
  uri: string;
  toolInput: Record<string, any>;
  toolOutput: any;
  toolResponseMetadata?: Record<string, any> | null;
  toolId: string;
  theme?: "light" | "dark";
  timestamp: number;
}

const widgetDataStore = new Map<string, WidgetData>();

// Cleanup expired widget data every 5 minutes
setInterval(
  () => {
    const now = Date.now();
    const ONE_HOUR = 60 * 60 * 1000;
    for (const [toolId, data] of widgetDataStore.entries()) {
      if (now - data.timestamp > ONE_HOUR) {
        widgetDataStore.delete(toolId);
      }
    }
  },
  5 * 60 * 1000,
).unref();

// List resources endpoint
resources.post("/list", async (c) => {
  let serverId: string | undefined;
  let cursor: string | undefined;
  try {
    const body = (await c.req.json()) as {
      serverId?: string;
      cursor?: string;
    };
    serverId = body.serverId;
    cursor = body.cursor;
    if (!serverId) {
      return c.json({ success: false, error: "serverId is required" }, 400);
    }
    const mcpClientManager = c.mcpClientManager;
    const result = await mcpClientManager.listResources(
      serverId,
      cursor ? { cursor } : undefined,
    );
    return c.json({
      resources: result.resources,
      nextCursor: result.nextCursor,
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
    const result = (await c.req.json()) as {
      serverId?: string;
      uri?: string;
    };
    serverId = result.serverId;
    uri = result.uri;
    if (!serverId) {
      return c.json({ success: false, error: "serverId is required" }, 400);
    }

    if (!uri) {
      return c.json(
        {
          success: false,
          error: "Resource URI is required",
        },
        400,
      );
    }

    const mcpClientManager = c.mcpClientManager;

    const content = await mcpClientManager.readResource(serverId, {
      uri,
    });

    return c.json({ content });
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
