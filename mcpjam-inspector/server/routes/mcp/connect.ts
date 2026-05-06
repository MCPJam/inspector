import { Hono } from "hono";
import "../../types/hono"; // Type extensions
import { logger } from "../../utils/logger";
import {
  parseConnectionDefaults,
  readLocalApiBearer,
  resolveLocalServerForConnect,
} from "../../utils/local-server-resolver.js";
import { WebRouteError } from "../web/errors.js";

const connect = new Hono();

connect.post("/", async (c) => {
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

  // The MCP client manager is keyed by display name across the local API
  // surface (tools list/execute, status, etc. all pass display names from
  // the UI). The Convex `serverId` is used only as the lookup key into
  // /web/authorize-batch-local and is never used as a manager key.
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

  const mcpClientManager = c.mcpClientManager;

  let resolved;
  try {
    resolved = await resolveLocalServerForConnect(
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
  } catch (error) {
    if (error instanceof WebRouteError) {
      // OAuth-required 401s aren't a session-auth failure — the actor is
      // signed in, the server just needs the user to complete its OAuth
      // flow. Tag the response so authFetch doesn't waste a guest-session
      // refresh round-trip that would inevitably hit the same 401.
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
    return c.json(
      {
        success: false,
        error: "Failed to resolve server config",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }

  try {
    // First connect can have nothing to disconnect; treat that as non-fatal
    // so the path doesn't 500 before connectToServer runs. Mirrors the
    // /servers/reconnect handler's tolerance.
    try {
      await mcpClientManager.disconnectServer(serverDisplayName);
    } catch (disconnectError) {
      logger.debug("Failed to disconnect MCP server before connect", {
        serverId: serverDisplayName,
        error:
          disconnectError instanceof Error
            ? disconnectError.message
            : String(disconnectError),
      });
    }
    await mcpClientManager.connectToServer(serverDisplayName, resolved.config);
    return c.json({ success: true, status: "connected" });
  } catch (error) {
    try {
      await mcpClientManager.removeServer(serverDisplayName);
    } catch (cleanupError) {
      logger.debug("Failed to remove MCP server after connection failure", {
        serverId: serverDisplayName,
        error:
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError),
      });
    }
    return c.json(
      {
        success: false,
        error: `Connection failed for server ${serverDisplayName}: ${error instanceof Error ? error.message : "Unknown error"}`,
        details: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

export default connect;
