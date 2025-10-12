import { Hono } from "hono";
import type { MCPServerConfig } from "@/shared/mcp-client-manager";
import "../../types/hono"; // Type extensions

const servers = new Hono();

// List all connected servers with their status
servers.get("/", async (c) => {
  try {
    const mcpClientManager = c.mcpClientManager;
    const serverList = mcpClientManager
      .getServerSummaries()
      .map(({ id, status, config }) => ({
        id,
        name: id,
        status,
        config,
      }));

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

servers.get("/status/:serverId", async (c) => {
  try {
    const serverId = c.req.param("serverId");
    const mcpClientManager = c.mcpClientManager;
    const status = mcpClientManager.getConnectionStatus(serverId);

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
    const mcpClientManager = c.mcpClientManager;

    try {
      const client = mcpClientManager.getClient(serverId);
      if (client) {
        await mcpClientManager.disconnectServer(serverId);
      }
    } catch (error) {
      // Ignore disconnect errors for already disconnected servers
      console.debug(
        `Failed to disconnect MCP server ${serverId} during removal`,
        error,
      );
    }

    mcpClientManager.removeServer(serverId);

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
    const { serverId, serverConfig } = (await c.req.json()) as {
      serverId?: string;
      serverConfig?: MCPServerConfig;
    };

    if (!serverId || !serverConfig) {
      return c.json(
        {
          success: false,
          error: "serverId and serverConfig are required",
        },
        400,
      );
    }

    const mcpClientManager = c.mcpClientManager;

    const normalizedConfig: MCPServerConfig = { ...serverConfig };
    if (
      "url" in normalizedConfig &&
      normalizedConfig.url !== undefined &&
      normalizedConfig.url !== null
    ) {
      const urlValue = normalizedConfig.url as unknown;
      if (typeof urlValue === "string") {
        normalizedConfig.url = new URL(urlValue);
      } else if (urlValue instanceof URL) {
        // already normalized
      } else if (
        typeof urlValue === "object" &&
        urlValue !== null &&
        "href" in (urlValue as Record<string, unknown>) &&
        typeof (urlValue as { href?: unknown }).href === "string"
      ) {
        normalizedConfig.url = new URL((urlValue as { href: string }).href);
      }
    }

    try {
      const client = mcpClientManager.getClient(serverId);
      if (client) {
        await mcpClientManager.disconnectServer(serverId);
      }
    } catch {
      // Ignore disconnect errors prior to reconnect
    }
    await mcpClientManager.connectToServer(serverId, normalizedConfig);

    const status = mcpClientManager.getConnectionStatus(serverId);
    const message =
      status === "connected"
        ? `Reconnected to server: ${serverId}`
        : `Server ${serverId} reconnected with status '${status}'`;
    const success = status === "connected";

    return c.json({
      success,
      serverId,
      status,
      message,
      ...(success ? {} : { error: message }),
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
