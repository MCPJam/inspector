import { Hono } from "hono";
import "../../types/hono"; // Type extensions

const connect = new Hono();

connect.post("/", async (c) => {
  try {
    const { serverConfig, serverId } = await c.req.json();

    if (!serverConfig) {
      return c.json(
        {
          success: false,
          error: "serverConfig is required",
        },
        400,
      );
    }

    if (!serverId) {
      return c.json(
        {
          success: false,
          error: "serverId is required",
        },
        400,
      );
    }

    if (serverConfig.url) {
      if (typeof serverConfig.url === "string") {
        serverConfig.url = new URL(serverConfig.url);
      } else if (
        typeof serverConfig.url === "object" &&
        serverConfig.url.href
      ) {
        serverConfig.url = new URL(serverConfig.url.href);
      }
    }

    const mcpClientManager = c.mcpClientManager;
    try {
      // Disconnect first if already connected to avoid "already connected" errors
      await mcpClientManager.disconnectServer(serverId);
      await mcpClientManager.connectToServer(serverId, serverConfig);
      return c.json({
        success: true,
        status: "connected",
      });
    } catch (error) {
      return c.json(
        {
          success: false,
          error: `Connection failed for server ${serverId}: ${error instanceof Error ? error.message : "Unknown error"}`,
          details: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  } catch (error) {
    return c.json(
      {
        success: false,
        error: "Failed to parse request body",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      400,
    );
  }
});

export default connect;
