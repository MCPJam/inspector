import { Hono } from "hono";
import "../../types/hono"; // Type extensions

const servers = new Hono();

// List all connected servers with their status
servers.get("/", async (c) => {
  // TODO: Figure out how to incorporate MCPClientManager
  try {
    const mcpJamClientManager = c.mcpJamClientManager;
    // Get all server configurations and statuses
    const connectedServers = mcpJamClientManager.getConnectedServers();
    const serverList = Object.entries(connectedServers).map(
      ([serverId, serverInfo]) => ({
        id: serverId,
        name: serverId,
        status: serverInfo.status,
        config: serverInfo.config,
      }),
    );

    return c.json({
      success: true,
      servers: serverList,
    });
  } catch (error) {
    console.error("Error listing servers:", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// Get status for a specific server
servers.get("/status/:serverId", async (c) => {
  try {
    const serverId = c.req.param("serverId");
    const mcpJamClientManager = c.mcpJamClientManager;
    const status = mcpJamClientManager.getConnectionStatus(serverId);

    return c.json({
      success: true,
      serverId,
      status,
    });
  } catch (error) {
    console.error("Error getting server status:", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// Disconnect from a server
servers.delete("/:serverId", async (c) => {
  try {
    const serverId = c.req.param("serverId");
    const mcpJamClientManager = c.mcpJamClientManager; // TODO: Remove MCPJamClientManager
    const mcpClientManager = c.mcpClientManager;
    await mcpClientManager.disconnectServer(serverId);
    await mcpJamClientManager.disconnectFromServer(serverId);

    return c.json({
      success: true,
      message: `Disconnected from server: ${serverId}`,
    });
  } catch (error) {
    console.error("Error disconnecting server:", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// Reconnect to a server
servers.post("/reconnect", async (c) => {
  try {
    const { serverId, serverConfig } = await c.req.json();

    if (!serverId || !serverConfig) {
      return c.json(
        {
          success: false,
          error: "serverId and serverConfig are required",
        },
        400,
      );
    }

    const mcpJamClientManager = c.mcpJamClientManager; // TODO: Remove MCPJamClientManager
    const mcpClientManager = c.mcpClientManager;

    await mcpClientManager.disconnectServer(serverId);
    await mcpClientManager.connectToServer(serverId, serverConfig);

    // Disconnect first, then reconnect
    await mcpJamClientManager.disconnectFromServer(serverId);
    await mcpJamClientManager.connectToServer(serverId, serverConfig);

    const status = mcpJamClientManager.getConnectionStatus(serverId);

    return c.json({
      success: true,
      serverId,
      status,
      message: `Reconnected to server: ${serverId}`,
    });
  } catch (error) {
    console.error("Error reconnecting server:", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

export default servers;
