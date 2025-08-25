import { Hono } from "hono";
import "../../types/hono"; // Type extensions
import MCPJamClientManager from "../../services/mcpjam-client-manager";

const connect = new Hono();

connect.post("/", async (c) => {
  try {
    const { serverConfig } = await c.req.json();

    if (!serverConfig) {
      return c.json(
        {
          success: false,
          error: "serverConfig is required",
        },
        400,
      );
    }

    const mcpClientManager = c.get("mcpAgent") as MCPJamClientManager;
    const serverId =
      (serverConfig as any).name || (serverConfig as any).id || "server";

    try {
      // Test connection via centralized agent
      await mcpClientManager.connectToServer(serverId, serverConfig);

      // Check connection status
      const status = mcpClientManager.getConnectionStatus(serverId);
      if (status === "connected") {
        return c.json({
          success: true,
          status: "connected",
        });
      } else {
        return c.json(
          {
            success: false,
            error: "Connection failed",
            status,
          },
          500,
        );
      }
    } catch (error) {
      return c.json(
        {
          success: false,
          error: `MCP configuration is invalid. Please double check your server configuration: ${JSON.stringify(serverConfig)}`,
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
