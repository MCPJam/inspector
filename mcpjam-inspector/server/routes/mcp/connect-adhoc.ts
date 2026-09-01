import { Hono } from "hono";
import "../../types/hono"; // Type extensions (c.mcpClientManager)
import type { MCPServerConfig } from "@mcpjam/sdk";
import { buildConnectSuccessEnvelope } from "../../utils/local-server-resolver.js";
import { logger } from "../../utils/logger";

/**
 * connect-adhoc.ts — `POST /api/mcp/connect-adhoc`: register a fully-specified
 * MCP server connection in the local manager from an INLINE config, with no
 * project/Convex lookup.
 *
 * Why this exists separately from `/api/mcp/connect`: the project-scoped connect
 * route resolves a server's config from Convex by `projectId` + `serverId` (the
 * legacy inline `{serverConfig}` body was removed in the local-mode purge). The
 * CLI's harness-render flows (`mcpjam apps render` / `apps session`, inspector
 * render) target an ad-hoc `--url`/`--command` server that exists in no project,
 * so they have no `projectId` to offer — `/connect` 400s with "projectId is
 * required". This route restores the inline-config path for exactly those
 * callers: it takes `{ serverId, serverConfig }` and connects it directly, the
 * same way the CLI's in-process ephemeral manager (`tools list`) already does.
 *
 * Local-Inspector capability only: it lives under `/api/mcp/*`, which
 * `server/app.ts` mounts solely when `!HOSTED_MODE`, so an inline config can
 * never open a server-side connection (or spawn a stdio process) on the hosted
 * image — only on the user's own machine.
 */

const connectAdhoc = new Hono();

connectAdhoc.post("/", async (c) => {
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
      400,
    );
  }

  const raw = (body ?? {}) as Record<string, unknown>;
  const serverId =
    typeof raw.serverId === "string" ? raw.serverId.trim() : "";
  if (!serverId) {
    return c.json({ success: false, error: "serverId is required" }, 400);
  }
  if (
    typeof raw.serverConfig !== "object" ||
    raw.serverConfig === null ||
    Array.isArray(raw.serverConfig)
  ) {
    return c.json(
      { success: false, error: "serverConfig must be a JSON object" },
      400,
    );
  }
  const serverConfig = raw.serverConfig as MCPServerConfig;

  const mcpClientManager = c.mcpClientManager;

  // Tolerate "nothing to disconnect" — a fresh ad-hoc connect has no manager
  // entry yet, and a stale/already-disconnected entry under the same id
  // shouldn't fail the call. Mirrors `executeLocalServerConnect`.
  try {
    await mcpClientManager.disconnectServer(serverId);
  } catch (disconnectError) {
    logger.debug("Failed to disconnect MCP server before ad-hoc connect", {
      serverId,
      error:
        disconnectError instanceof Error
          ? disconnectError.message
          : String(disconnectError),
    });
  }

  try {
    await mcpClientManager.connectToServer(serverId, serverConfig);
  } catch (error) {
    // Clean up the doomed entry so it doesn't shadow a later connect/listServers
    // under the same id (same as `/connect`'s first-time-connect path).
    try {
      await mcpClientManager.removeServer(serverId);
    } catch (cleanupError) {
      logger.debug("Failed to remove MCP server after ad-hoc connect failure", {
        serverId,
        error:
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError),
      });
    }
    return c.json(
      {
        success: false,
        error: `Connection failed for server ${serverId}: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
        details: error instanceof Error ? error.message : "Unknown error",
      },
      502,
    );
  }

  return c.json(buildConnectSuccessEnvelope(mcpClientManager, serverId));
});

export default connectAdhoc;
