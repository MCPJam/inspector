import { Hono } from "hono";
import { ContentfulStatusCode } from "hono/utils/http-status";
import "../../types/hono"; // Type extensions

const resources = new Hono();

// List resources endpoint
resources.post("/list", async (c) => {
  try {
    const { serverConfig } = await c.req.json();

    if (!serverConfig) {
      return c.json({ success: false, error: "serverConfig is required" }, 400);
    }

    const agent = c.get("mcpAgent");
    const serverId =
      (serverConfig as any).name || (serverConfig as any).id || "server";

    // Connect to server via centralized agent
    await agent.connectToServer(serverId, serverConfig);

    // Get resources from agent's registry
    const allResources = agent.getAvailableResources();
    const normalizedServerId = serverId
      .toLowerCase()
      .replace(/[\s\-]+/g, "_")
      .replace(/[^a-z0-9_]/g, "");
    const serverResources = allResources.filter(
      (r) => r.serverId === normalizedServerId,
    );

    return c.json({ resources: { [serverId]: serverResources } });
  } catch (error) {
    console.error("Error fetching resources:", error);
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
  try {
    const { serverConfig, uri } = await c.req.json();

    if (!serverConfig) {
      return c.json({ success: false, error: "serverConfig is required" }, 400);
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

    const agent = c.get("mcpAgent");
    const serverId =
      (serverConfig as any).name || (serverConfig as any).id || "server";

    // Connect to server via centralized agent
    await agent.connectToServer(serverId, serverConfig);

    // Use agent to get resource content
    const content = await agent.getResource(uri);

    return c.json({ content });
  } catch (error) {
    console.error("Error reading resource:", error);
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
