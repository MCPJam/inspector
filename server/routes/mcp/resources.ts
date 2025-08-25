import { Hono } from "hono";
import "../../types/hono"; // Type extensions
import MCPJamClientManager from "../../services/mcpjam-client-manager";

const resources = new Hono();

// List resources endpoint
resources.post("/list", async (c) => {
  try {
    const { serverId } = await c.req.json();

    if (!serverId) {
      return c.json({ success: false, error: "serverId is required" }, 400);
    }
    const mcpClientManager = c.get(
      "mcpJamClientManager",
    ) as MCPJamClientManager;
    const serverResources = mcpClientManager.getResourcesForServer(serverId);
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
    const { serverId, uri } = await c.req.json();

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

    const mcpClientManager = c.get(
      "mcpJamClientManager",
    ) as MCPJamClientManager;

    const content = await mcpClientManager.getResource(uri, serverId);

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
