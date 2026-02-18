import { Hono } from "hono";
import "../../types/hono"; // Type extensions
import { logger } from "../../utils/logger";
import { listResources, readResource } from "../../utils/route-handlers.js";

const resources = new Hono();

// List resources endpoint
resources.post("/list", async (c) => {
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
    return c.json(await listResources(c.mcpClientManager, { serverId, cursor: body.cursor }));
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
    };
    serverId = body.serverId;
    uri = body.uri;
    if (!serverId) {
      return c.json({ success: false, error: "serverId is required" }, 400);
    }
    if (!uri) {
      return c.json(
        { success: false, error: "Resource URI is required" },
        400,
      );
    }
    return c.json(await readResource(c.mcpClientManager, { serverId, uri }));
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
