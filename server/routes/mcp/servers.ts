import { Hono } from "hono";
import type { MCPServerConfig } from "@/sdk";
import "../../types/hono"; // Type extensions
import { rpcLogBus, type RpcLogEvent } from "../../services/rpc-log-bus";
import { logger } from "../../utils/logger";

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
    logger.error("Error listing servers", error);
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
    const status =
      mcpClientManager.getConnectionStatusByAttemptingPing(serverId);

    return c.json({
      success: true,
      serverId,
      status,
    });
  } catch (error) {
    logger.error("Error getting server status", error, { serverId });
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// Get initialization metadata for a server
servers.get("/init-info/:serverId", async (c) => {
  try {
    const serverId = c.req.param("serverId");
    const mcpClientManager = c.mcpClientManager;
    const initInfo = mcpClientManager.getInitializationInfo(serverId);

    if (!initInfo) {
      return c.json(
        {
          success: false,
          error: `Server "${serverId}" is not connected or initialization info not available`,
        },
        404,
      );
    }

    return c.json({
      success: true,
      serverId,
      initInfo,
    });
  } catch (error) {
    logger.error("Error getting initialization info", error, { serverId });
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
    logger.error("Error disconnecting server", error, { serverId });
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

    await mcpClientManager.disconnectServer(serverId);
    await mcpClientManager.connectToServer(serverId, normalizedConfig);

    const status =
      mcpClientManager.getConnectionStatusByAttemptingPing(serverId);
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
    logger.error("Error reconnecting server", error, { serverId });
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// Stream JSON-RPC messages over SSE for all servers.
servers.get("/rpc/stream", async (c) => {
  const serverIds = c.mcpClientManager.listServers();
  const url = new URL(c.req.url);
  const replay = parseInt(url.searchParams.get("replay") || "0", 10);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (data: unknown) => {
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
          );
        } catch {}
      };

      // Replay recent messages for all known servers
      try {
        const recent = rpcLogBus.getBuffer(
          serverIds,
          isNaN(replay) ? 0 : replay,
        );
        for (const evt of recent) {
          send({ type: "rpc", ...evt });
        }
      } catch {}

      // Subscribe to live events for all known servers
      const unsubscribe = rpcLogBus.subscribe(serverIds, (evt: RpcLogEvent) => {
        send({ type: "rpc", ...evt });
      });

      // Keepalive comments
      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: keepalive ${Date.now()}\n\n`));
        } catch {}
      }, 15000);

      // Cleanup on client disconnect
      c.req.raw.signal.addEventListener("abort", () => {
        try {
          clearInterval(keepalive);
          unsubscribe();
        } catch {}
        try {
          controller.close();
        } catch {}
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "*",
    },
  });
});

export default servers;
