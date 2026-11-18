import { commandApprovalReview } from "./command-approval-review.js";
import { promoteLocalServerCheck } from "../../utils/local-server-check-queue.js";
import {
  listBaseServers,
  localConnectionKeysForServer,
  removeServerConnections,
} from "../../utils/mcp-connections.js";
import { Hono } from "hono";
import "../../types/hono"; // Type extensions
import {
  rpcLogBus,
  type DeliveredRpcLogEvent,
} from "../../services/rpc-log-bus";
import { logger } from "../../utils/logger";
import { reportRouteFailure, readRequestJson } from "../../utils/route-error-report.js";
import {
  authorizeServerLocal,
  executeLocalServerConnect,
  parseLocalConnectRequestBody,
  readAuthorizedStdioLaunchSpec,
  readLocalApiBearer,
  respondWithLocalRouteError,
} from "../../utils/local-server-resolver.js";
import { resolveServerCanvasRollout } from "../../utils/server-canvas-rollout.js";
import {
  claimCanvasRefresh,
  runCanvasRefresh,
} from "../../services/server-canvas/refresh.js";
import {
  approveStdioLaunch,
  checkStdioLaunchApproval,
  FINGERPRINT_PATTERN,
  stdioCommandApprovalTerms,
  stdioLaunchFingerprint,
  toStdioLaunchSpec,
} from "../../utils/stdio-command-approvals.js";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { STDIO_COMMAND_APPROVAL_REQUIRED_REASON } from "../../../shared/stdio-command-approval.js";
import { releasePluginLease } from "../../services/plugins/local-stdio.js";

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

function isNonEmptyRecord(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    Object.keys(value as Record<string, unknown>).length > 0
  );
}

/**
 * The config fields the browser reads from this list: the connection card and
 * edit form (`url`, `command`, `args`, `timeout`, capabilities), the wire
 * version pin, and which secrets exist. Projected rather than redacted, so a
 * credential the SDK keeps on the config (`accessToken` after a refresh) or a
 * field added later stays in this process unless it is named here.
 */
const LISTED_CONFIG_FIELDS = [
  "url",
  "command",
  "args",
  "timeout",
  "capabilities",
  "clientCapabilities",
  "mcpProtocolVersion",
] as const;

function listedServerConfig(config: unknown) {
  if (!config || typeof config !== "object") {
    return config;
  }
  const record = config as Record<string, unknown>;
  const listed: Record<string, unknown> = {};
  for (const field of LISTED_CONFIG_FIELDS) {
    if (record[field] !== undefined) listed[field] = record[field];
  }
  if ("env" in record) listed.hasEnv = isNonEmptyRecord(record.env);
  const requestInit = record.requestInit;
  if (
    requestInit &&
    typeof requestInit === "object" &&
    "headers" in requestInit
  ) {
    listed.hasHeaders = isNonEmptyRecord(requestInit.headers);
    // Flagged so the edit form keeps the auth type as "bearer" and the
    // hidden token stays where it is.
    listed.hasBearerToken = hasBearerAuthorizationHeader(requestInit.headers);
  }
  return listed;
}

const servers = new Hono();
servers.route("/command-approval", commandApprovalReview);

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
        config: listedServerConfig(config),
      }));

    return c.json({
      success: true,
      servers: serverList,
    });
  } catch (error) {
    reportRouteFailure("Error listing servers", error, {
      // Pure local manager state — no hop into anyone's MCP server. If
      // enumerating our own summaries throws, that is our bug.
      source: "mcp.servers.list",
      hop: "mcpjam_internal",
    });
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
    reportRouteFailure("Error getting server status", error, {
      // Pings the user's server when connected; a failure here is usually
      // their server, not ours.
      source: "mcp.servers.status",
      hop: "user_server_hop",
      context: { serverId },
    });
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
    reportRouteFailure("Error getting initialization info", error, {
      // Reads cached init data off our own manager.
      source: "mcp.servers.init-info",
      hop: "mcpjam_internal",
      context: { serverId },
    });
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

    await removeServerConnections(mcpClientManager, serverId);
    await mcpClientManager.removeServer(serverId);
    // The replay buffer is keyed by server id and nothing ever removed a key,
    // so every disconnect used to leave its retained frames behind for the life
    // of the process. Dropped HERE rather than inside `removeServer` on
    // purpose: a failed connect removes the entry too, and those frames are the
    // ones the Logs panel is open to show.
    rpcLogBus.forgetServer(serverId);
    // The plugin bundle this entry may have been running from is now
    // unreferenced, so cache GC may reclaim it. No-op for ordinary servers.
    releasePluginLease(serverId);

    return c.json({
      success: true,
      message: `Disconnected from server: ${serverId}`,
    });
  } catch (error) {
    reportRouteFailure("Error disconnecting server", error, {
      // Closing a transport most often fails because the peer is already
      // gone.
      source: "mcp.servers.disconnect",
      hop: "user_server_hop",
      context: { serverId },
    });
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

servers.post("/checks/promote", promoteLocalServerCheck);

// Reconnect to a server. Body shape: {projectId, serverId, serverName}; the
// local Hono server resolves the config (and any OAuth tokens) from Convex
// via /web/authorize-batch-local.
servers.post("/reconnect", async (c) => {
  let body: unknown;
  try {
    body = await readRequestJson(c);
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

// Refresh the server canvas for a connected project server: a fresh capture
// and every background probe on the existing connection, behind
// `server-canvas`. Body: {projectId, serverId}. Answers 202 once queued; the
// page watches Convex for the results.
servers.post("/canvas/refresh", async (c) => {
  let body: unknown;
  try {
    body = await readRequestJson(c);
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
  const raw = (body ?? {}) as Record<string, unknown>;
  const projectId = typeof raw.projectId === "string" ? raw.projectId.trim() : "";
  const serverId = typeof raw.serverId === "string" ? raw.serverId.trim() : "";
  if (!projectId || !serverId) {
    return respondWithLocalRouteError(
      c,
      new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "projectId and serverId are required"
      )
    );
  }
  const bearer = readLocalApiBearer(c);
  if (!bearer) {
    return respondWithLocalRouteError(
      c,
      new WebRouteError(
        401,
        ErrorCode.UNAUTHORIZED,
        "Authorization bearer token is required"
      )
    );
  }
  try {
    if (!(await resolveServerCanvasRollout(bearer))) {
      return c.json({ status: "disabled" }, 409);
    }
    const authorized = await authorizeServerLocal(c, bearer, projectId, serverId);
    const manager = c.mcpClientManager;
    const managerKey = localConnectionKeysForServer(manager, serverId)[0];
    if (!managerKey) return c.json({ status: "not-connected" }, 409);
    // A refresh already running for this server answers for this one too.
    const release = claimCanvasRefresh({ caller: "local", projectId, serverId });
    if (!release) return c.json({ status: "accepted" }, 202);
    void runCanvasRefresh({
      hosted: false,
      projectId,
      serverId,
      manager,
      managerKey,
      convexBearer: bearer,
      ...(authorized.oauthCredentialId
        ? { accountKey: authorized.oauthCredentialId }
        : {}),
    })
      .then((run) => run.done)
      .finally(release);
    return c.json({ status: "accepted" }, 202);
  } catch (error) {
    if (error instanceof WebRouteError) {
      return respondWithLocalRouteError(c, error);
    }
    reportRouteFailure("Error refreshing the server canvas", error, {
      source: "mcp.servers.canvasRefresh",
      hop: "mcpjam_internal",
      context: { serverId },
    });
    return c.json(
      {
        success: false,
        error: "Refresh could not start. Try again in a moment.",
      },
      500
    );
  }
});

// Approve, on this device, the command a stdio server runs. Body:
// {projectId, serverId, serverName, fingerprint}, the fingerprint being the
// one the connect refusal showed. The row is re-read so the approval binds to
// what would run NOW; a stale fingerprint gets the current terms back instead.
servers.post("/approve-command", async (c) => {
  let body: unknown;
  try {
    body = await readRequestJson(c);
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
  const claimed = (body as Record<string, unknown>).fingerprint;
  if (typeof claimed !== "string" || !FINGERPRINT_PATTERN.test(claimed)) {
    return respondWithLocalRouteError(
      c,
      new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "fingerprint is required"
      )
    );
  }

  const { projectId, serverId, serverDisplayName, bearer } = parsed.params;
  try {
    const launch = await readAuthorizedStdioLaunchSpec({
      bearerToken: bearer,
      projectId,
      serverId,
      serverDisplayName,
    });
    const spec = toStdioLaunchSpec({ ...launch, cwd: launch.workingDirectory });
    const fingerprint = stdioLaunchFingerprint(spec);
    if (fingerprint !== claimed) {
      const { approval, changedEnvNames } = await checkStdioLaunchApproval(
        serverId,
        spec,
      );
      // Another tab may have approved the current command already.
      if (approval === "approved") {
        return c.json({ success: true, fingerprint });
      }
      return respondWithLocalRouteError(
        c,
        new WebRouteError(
          409,
          ErrorCode.CONFLICT,
          `The command "${serverDisplayName}" runs changed while you were reviewing it. Review the current command and approve again.`,
          {
            reason: STDIO_COMMAND_APPROVAL_REQUIRED_REASON,
            serverId,
            approval: stdioCommandApprovalTerms({
              serverId,
              spec,
              fingerprint,
              approval,
              changedEnvNames,
            }),
          }
        )
      );
    }
    await approveStdioLaunch(serverId, spec);
    return c.json({ success: true, fingerprint });
  } catch (error) {
    if (error instanceof WebRouteError) {
      return respondWithLocalRouteError(c, error);
    }
    reportRouteFailure("Error approving server command", error, {
      // Re-reads our own backend and writes a file under ~/.mcpjam.
      source: "mcp.servers.approve-command",
      hop: "mcpjam_internal",
      context: { serverId },
    });
    return c.json(
      {
        success: false,
        error: "Failed to approve the server command",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

// Stream JSON-RPC messages over SSE for all servers.
servers.get("/rpc/stream", async (c) => {
  const serverIds = listBaseServers(c.mcpClientManager);
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

      // Replay recent messages for all known servers.
      //
      // Every event carries the bus-assigned `eventId`, and the browser store
      // keys rows on it — so a client that already holds a replayed event
      // updates that row instead of appending a second copy of it.
      //
      // The spread below is what puts `eventId` on the wire. Keep it a spread:
      // picking fields explicitly here would drop the identity and silently
      // reintroduce duplicate rows in the Logs panel. Guarded by
      // `__tests__/rpc-stream-event-id.test.ts`, which parses these frames.
      try {
        const recent = rpcLogBus.getBuffer(
          serverIds,
          isNaN(replay) ? 0 : replay
        );
        for (const evt of recent) {
          send({ type: evt.kind === "http" ? "http" : "rpc", ...evt });
        }
      } catch {}

      // Subscribe to live events for all known servers. Same spread, same
      // reason as the replay loop above — this is the second of the two places
      // `eventId` reaches the wire.
      const unsubscribe = rpcLogBus.subscribe(
        serverIds,
        (evt: DeliveredRpcLogEvent) => {
          send({ type: evt.kind === "http" ? "http" : "rpc", ...evt });
        }
      );

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
