import { Hono } from "hono";
import "../../types/hono"; // Type extensions
import { rpcLogBus, type RpcLogEvent } from "../../services/rpc-log-bus";
import { logger } from "../../utils/logger";
import {
  executeLocalServerConnect,
  parseLocalConnectRequestBody,
  respondWithLocalRouteError,
} from "../../utils/local-server-resolver.js";

function hasBearerAuthorizationHeader(headers: unknown): boolean {
  if (!headers || typeof headers !== "object") {
    return false;
  }
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (
      key.trim().toLowerCase() === "authorization" &&
      typeof value === "string" &&
      value.startsWith("Bearer ")
    ) {
      return true;
    }
  }
  return false;
}

function redactServerConfig(config: unknown) {
  if (!config || typeof config !== "object") {
    return config;
  }
  const record = config as Record<string, unknown>;
  const redacted: Record<string, unknown> = { ...record };
  if ("env" in redacted) {
    redacted.hasEnv =
      !!redacted.env &&
      typeof redacted.env === "object" &&
      Object.keys(redacted.env as Record<string, unknown>).length > 0;
    delete redacted.env;
  }
  const requestInit = redacted.requestInit;
  if (
    requestInit &&
    typeof requestInit === "object" &&
    !Array.isArray(requestInit)
  ) {
    const nextRequestInit = { ...(requestInit as Record<string, unknown>) };
    if ("headers" in nextRequestInit) {
      redacted.hasHeaders =
        !!nextRequestInit.headers &&
        typeof nextRequestInit.headers === "object" &&
        Object.keys(nextRequestInit.headers as Record<string, unknown>).length >
          0;
      // Flag bearer auth before the header value is stripped, so the edit form
      // can keep the auth type as "bearer" and preserve the hidden token.
      redacted.hasBearerToken = hasBearerAuthorizationHeader(
        nextRequestInit.headers
      );
      delete nextRequestInit.headers;
    }
    redacted.requestInit = nextRequestInit;
  }
  return redacted;
}

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
        config: redactServerConfig(config),
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
      500
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
      500
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
        404
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
      500
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
      // `getClient()` returns undefined for stateless connections (no
      // wrapped upstream Client). Use `getManagedClient()` so this guard
      // recognizes both adapters and we actually call `disconnectServer`
      // for stateless preview connections instead of leaking them.
      const managedClient = mcpClientManager.getManagedClient(serverId);
      if (managedClient) {
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
      500
    );
  }
});

// Reconnect to a server. Body shape: {projectId, serverId, serverName}; the
// local Hono server resolves the config (and any OAuth tokens) from Convex
// via /web/authorize-batch-local.
servers.post("/reconnect", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch (error) {
    return c.json(
      {
        success: false,
        error: "Failed to parse request body",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      400
    );
  }

  const parsed = parseLocalConnectRequestBody(c, body);
  if (!parsed.ok) {
    return respondWithLocalRouteError(c, parsed.error);
  }

  // Reconnect leaves the manager entry in place on failure — the caller
  // intends to retry, and removing it would also drop any in-flight
  // streams (tools/RPC) that pointed at this name.
  return executeLocalServerConnect(c, parsed.params, {
    removeOnFailure: false,
  });
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
            encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
          );
        } catch {}
      };

      // Replay recent messages for all known servers
      try {
        const recent = rpcLogBus.getBuffer(
          serverIds,
          isNaN(replay) ? 0 : replay
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
