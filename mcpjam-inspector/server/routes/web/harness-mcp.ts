/**
 * Hosted-plane harness MCP proxy: `POST /api/web/harness-mcp/:serverId`.
 *
 * The Claude Code harness (in a cloud sandbox) speaks MCP JSON-RPC to THIS
 * route, which forwards to the user's real MCP server through MCPJam — so the
 * harness's MCP runs through the playground even in the horizontally-scaled
 * hosted plane. Auth is the **signed proxy token** (NOT a browser bearer): it
 * carries the acting user's delegated identity, which we hand to the existing
 * `workos_api_key` acting-as path so the per-request `createAuthorizedManager`
 * rebuilds the user's authorized connection server-side. Stateless — any
 * instance serves it.
 *
 * Mounted WITHOUT `bearerAuthMiddleware` (the token is the auth);
 * `sessionAuthMiddleware` already bypasses `/api/web/*`.
 *
 * Transport: mirrors `adapter-http`'s raw-spec shape that the Phase-0 spike
 * proved Claude Code's `type:"http"` client speaks — POST → single
 * `application/json`; the optional GET returns a minimal server-stream the
 * client probes then closes; no `Mcp-Session-Id` (stateless).
 */
import { Hono } from "hono";
import "../../types/hono";
import { handleJsonRpc } from "../../services/mcp-http-bridge";
import {
  createAuthorizedManager,
  withManager,
  type ManagerCallerContext,
} from "./auth";
import { verifyHarnessProxyToken } from "../../utils/harness/harness-proxy-token";
import { logger } from "../../utils/logger";

const harnessMcp = new Hono();

/** Per-request connect timeout for the authorized manager. */
const HARNESS_MCP_TIMEOUT_MS = 30_000;
/** Hard cap on the probe GET event-stream so a forgotten stream can't leak. */
const HARNESS_MCP_STREAM_MAX_MS = 10 * 60_000;
/** Lightweight fixed-window rate limit per (user, server). */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_WINDOW = 600;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    // Opportunistic prune so the map can't grow unbounded.
    if (rateBuckets.size > 5000) {
      for (const [k, b] of rateBuckets) if (now >= b.resetAt) rateBuckets.delete(k);
    }
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_MAX_PER_WINDOW;
}

/**
 * HEADER-ONLY (Phase 4 hardening): the token must arrive as
 * `X-MCPJam-Proxy-Token`. The old `?t=` query fallback is removed — tokens in
 * URLs leak into relay/edge/access logs. (The tunnel's own `?k=` secret is a
 * separate, edge-consumed credential and is untouched.)
 */
function readProxyToken(c: any): string | undefined {
  return c.req.header("x-mcpjam-proxy-token") || undefined;
}

async function handle(c: any) {
  const serverId = c.req.param("serverId");

  // Token is REQUIRED here (unlike adapter-http's validate-when-present) — it
  // is the only auth on this route, and carries the delegated identity.
  const claims = verifyHarnessProxyToken(readProxyToken(c), serverId);
  if (!claims || !claims.externalId || !claims.orgId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  if (rateLimited(`${claims.userId}:${serverId}`)) {
    return c.json({ error: "Rate limited" }, 429);
  }

  const method = c.req.method;

  // Optional GET server-stream: Claude Code opens it then (per Phase 0) closes
  // it. We have no persistent connection to relay from in this stateless route,
  // so return a minimal keep-alive event-stream and clean up on disconnect.
  if (method === "GET" || method === "HEAD") {
    if (method === "HEAD") {
      return c.body(null, 200, { "Content-Type": "text/event-stream" });
    }
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setInterval> | undefined;
    let killAt: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearInterval(timer);
      if (killAt) clearTimeout(killAt);
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`: ok\n\n`));
        timer = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(`: keepalive\n\n`));
          } catch {}
        }, 15000);
        // Hard cap: never hold the stream open indefinitely.
        killAt = setTimeout(() => {
          cleanup();
          try {
            controller.close();
          } catch {}
        }, HARNESS_MCP_STREAM_MAX_MS);
      },
      cancel() {
        cleanup();
      },
    });
    return c.body(stream as any, 200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
  }

  if (method !== "POST") {
    return c.json({ error: "Unsupported request" }, 400);
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    body = undefined;
  }

  // Rebuild the user's authorized connection server-side via the acting-as
  // service-token exchange (no browser bearer in the sandbox). Convex baked the
  // verified identity into the token; Convex also access-checked the server at
  // mint time, so membership authorization here is the project-ownership path.
  const caller: ManagerCallerContext = {
    authMethod: "workos_api_key",
    workosUserId: claims.externalId,
    mcpjamOrganizationId: claims.orgId,
  };

  try {
    const response = await withManager(
      createAuthorizedManager(
        caller,
        "", // bearer ignored on the workos_api_key path
        claims.projectId,
        [serverId],
        HARNESS_MCP_TIMEOUT_MS,
      ),
      (manager) => handleJsonRpc(serverId, body, manager, "adapter"),
    );
    // Notification (no id) → 202 Accepted, no body.
    if (!response) return c.body("Accepted", 202);
    return c.json(response);
  } catch (e: any) {
    // Log the real cause server-side, but NEVER leak internal exception text to
    // the sandbox — return a generic JSON-RPC error so the client can recover.
    logger.error(
      `[harness-mcp] proxy error serverId=${serverId}: ${e?.message ?? e}`,
    );
    return c.json(
      {
        jsonrpc: "2.0",
        id: body?.id ?? null,
        error: { code: -32000, message: "harness proxy error" },
      },
      200,
    );
  }
}

harnessMcp.all("/:serverId", handle);
harnessMcp.all("/:serverId/*", handle);

export { harnessMcp };
