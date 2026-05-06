import { Hono } from "hono";
import "../../types/hono"; // Type extensions
import { HOSTED_MODE } from "../../config";
import {
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

  // New shape: {projectId, serverId}. Server resolves config + tokens from
  // Convex via /web/authorize-batch-local. Mirrors hosted PR #2024.
  const projectId =
    typeof body?.projectId === "string" ? body.projectId.trim() : "";
  const useResolverPath = projectId.length > 0;

  const mcpClientManager = c.mcpClientManager;

  if (useResolverPath) {
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
        },
      );
    } catch (error) {
      if (error instanceof WebRouteError) {
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
      await mcpClientManager.disconnectServer(serverDisplayName);
      await mcpClientManager.connectToServer(serverDisplayName, resolved.config);
      return c.json({ success: true, status: "connected" });
    } catch (error) {
      try {
        await mcpClientManager.removeServer(serverDisplayName);
      } catch (cleanupError) {
        console.debug(
          `Failed to remove MCP server ${serverDisplayName} after connection failure`,
          cleanupError,
        );
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
  }

  // Legacy shape: {serverConfig, serverId}. Retained during the Phase 5–7
  // client migration so existing inspector builds keep working until clients
  // are flipped to the new {projectId, serverId} shape. To remove: drop this
  // branch and update connect.test.ts to remove the legacy assertions.
  const { serverConfig } = body;
  if (!serverConfig) {
    return c.json(
      { success: false, error: "serverConfig is required" },
      400,
    );
  }

  if (serverConfig.url) {
    try {
      if (typeof serverConfig.url === "string") {
        serverConfig.url = new URL(serverConfig.url);
      } else if (
        typeof serverConfig.url === "object" &&
        serverConfig.url.href
      ) {
        serverConfig.url = new URL(serverConfig.url.href);
      }
    } catch {
      return c.json(
        { success: false, error: "Invalid server URL" },
        400,
      );
    }
  }

  // Block STDIO connections in hosted mode (security: prevents RCE)
  if (HOSTED_MODE && serverConfig.command) {
    return c.json(
      { success: false, error: "STDIO transport is disabled in the web app" },
      403,
    );
  }

  // Enforce HTTPS in hosted mode
  if (HOSTED_MODE && serverConfig.url) {
    if (serverConfig.url.protocol !== "https:") {
      return c.json(
        {
          success: false,
          error:
            "HTTPS is required in the web app. Please use an https:// URL.",
        },
        400,
      );
    }
  }

  try {
    await mcpClientManager.disconnectServer(serverId);
    await mcpClientManager.connectToServer(serverId, serverConfig);
    return c.json({ success: true, status: "connected" });
  } catch (error) {
    try {
      await mcpClientManager.removeServer(serverId);
    } catch (cleanupError) {
      console.debug(
        `Failed to remove MCP server ${serverId} after connection failure`,
        cleanupError,
      );
    }
    return c.json(
      {
        success: false,
        error: `Connection failed for server ${serverId}: ${error instanceof Error ? error.message : "Unknown error"}`,
        details: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

export default connect;
