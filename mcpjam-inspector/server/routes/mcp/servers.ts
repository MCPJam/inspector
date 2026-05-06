import { Hono } from "hono";
import "../../types/hono"; // Type extensions
import { rpcLogBus, type RpcLogEvent } from "../../services/rpc-log-bus";
import { logger } from "../../utils/logger";
import {
  parseConnectionDefaults,
  readLocalApiBearer,
  resolveLocalServerForConnect,
} from "../../utils/local-server-resolver.js";
import { WebRouteError } from "../web/errors.js";

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
  let serverId: string | undefined;
  try {
    serverId = c.req.param("serverId");
    const mcpClientManager = c.mcpClientManager;
    const connectionStatus = mcpClientManager.getConnectionStatus(serverId);
    const ping =
      connectionStatus === "connected"
        ? await mcpClientManager.pingServer(serverId)
        : null;

    return c.json({
      success: true,
      serverId,
      status: connectionStatus,
      ping,
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
  let serverId: string | undefined;
  try {
    serverId = c.req.param("serverId");
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
  let serverId: string | undefined;
  try {
    serverId = c.req.param("serverId");
    const mcpClientManager = c.mcpClientManager;

    try {
      const client = mcpClientManager.getClient(serverId);
      if (client) {
        await mcpClientManager.disconnectServer(serverId);
      }
    } catch (error) {
      // Ignore disconnect errors for already disconnected servers
      logger.debug("Failed to disconnect MCP server during removal", {
        serverId,
        error: error instanceof Error ? error.message : String(error),
      });
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

// Reconnect to a server. Body shape: {projectId, serverId, serverName}; the
// local Hono server resolves the config (and any OAuth tokens) from Convex
// via /web/authorize-batch-local.
servers.post("/reconnect", async (c) => {
  let body: any;
  try {
    body = await c.req.json();
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

  const serverId =
    typeof body?.serverId === "string" ? body.serverId.trim() : "";
  if (!serverId) {
    return c.json(
      { success: false, error: "serverId is required" },
      400,
    );
  }

  const projectId =
    typeof body?.projectId === "string" ? body.projectId.trim() : "";
  if (!projectId) {
    return c.json(
      { success: false, error: "projectId is required" },
      400,
    );
  }
  const mcpClientManager = c.mcpClientManager;

  // The MCP client manager is keyed by display name; serverId is the Convex
  // document id used only for the resolver lookup.
  const serverDisplayName =
    typeof body?.serverName === "string" ? body.serverName.trim() : "";
  if (!serverDisplayName) {
    return c.json(
      { success: false, error: "serverName is required with projectId" },
      400,
    );
  }
  const bearer = readLocalApiBearer(c);
  if (!bearer) {
    return c.json(
      { success: false, error: "Authorization bearer token is required" },
      401,
    );
  }

  let normalizedConfig: import("@mcpjam/sdk").MCPServerConfig;
  const managerKey = serverDisplayName;

  try {
    const resolved = await resolveLocalServerForConnect(
      c,
      bearer,
      projectId,
      serverId,
      {
        serverDisplayName,
        clientCapabilities:
          typeof body?.clientCapabilities === "object" &&
          body.clientCapabilities !== null
            ? body.clientCapabilities
            : undefined,
        defaults: parseConnectionDefaults(body?.connectionDefaults),
      },
    );
    normalizedConfig = resolved.config;
  } catch (error) {
    if (error instanceof WebRouteError) {
      // See connect.ts — same rationale: an OAuth-required 401 means the
      // server demands the user complete its OAuth flow, not that the
      // session bearer is invalid. Skip the guest-refresh retry.
      if (error.details?.oauthRequired === true) {
        c.header("X-MCP-Auth-Required", "oauth");
      }
      return c.json(
        {
          success: false,
          error: error.message,
          ...(error.details ?? {}),
        },
        error.status as any,
      );
    }
    logger.error("Error resolving server config for reconnect", error, {
      serverId,
    });
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }

  try {
    // A stale or already-disconnected entry shouldn't fail reconnect; the
    // DELETE handler in this file uses the same tolerance.
    try {
      await mcpClientManager.disconnectServer(managerKey);
    } catch (disconnectError) {
      logger.debug("Failed to disconnect MCP server before reconnect", {
        serverId: managerKey,
        error:
          disconnectError instanceof Error
            ? disconnectError.message
            : String(disconnectError),
      });
    }
    await mcpClientManager.connectToServer(
      managerKey,
      normalizedConfig as import("@mcpjam/sdk").MCPServerConfig,
    );

    const status = mcpClientManager.getConnectionStatus(managerKey);
    const message =
      status === "connected"
        ? `Reconnected to server: ${managerKey}`
        : `Server ${managerKey} reconnected with status '${status}'`;
    const success = status === "connected";

    return c.json({
      success,
      serverId: managerKey,
      status,
      message,
      ...(success ? {} : { error: message }),
    });
  } catch (error) {
    logger.error("Error reconnecting server", error, { serverId: managerKey });
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
