import { Hono } from "hono";
import "../../types/hono";
import { handleJsonRpc, BridgeMode } from "../../services/mcp-http-bridge";
import {
  getServerIdForTunnelDomain,
  isActiveTunnelDomain,
} from "../../services/tunnel-registry";
import { recordTunnelRequest } from "../../services/tunnel-request-log";
import { getRequestLogger } from "../../utils/request-logger";

// In-memory SSE session store per serverId:sessionId
type Session = {
  send: (event: string, data: string) => void;
  close: () => void;
};
const sessions: Map<string, Session> = new Map();
const latestSessionByServer: Map<string, string> = new Map();

// ── Server→client notification relay ───────────────────────────────────────
// Real upstream notifications (progress, logging, *_list_changed, task
// status) are fanned out to every live SSE session for the server. One
// manager-level handler per method per server feeds a relay set, so SSE
// sessions come and go without handler churn on the MCP client.
//
// `pushFrameToClient` is deliberately method-agnostic: today it carries
// notifications, and a future server→client REQUEST channel (an id-bearing
// frame whose response arrives via POST /:serverId/messages) can ride the
// same path without reworking the stream. Sampling is deprecated and
// intentionally unsupported; elicitation will be wired once its product
// rework lands.
const RELAYED_NOTIFICATION_METHODS = [
  // Wire literals from the MCP spec; the SDK's exported constants cover a
  // subset of these, so the bridge standardizes on the literals.
  "notifications/progress",
  "notifications/message",
  "notifications/resources/list_changed",
  "notifications/resources/updated",
  "notifications/prompts/list_changed",
  "notifications/tools/list_changed",
  "notifications/tasks/status",
] as const;

const notificationRelays = new Map<string, Set<(payload: string) => void>>();
// Stable dispatcher instances per server+method. Registration must be
// re-runnable: removeServer() clears the manager's stored handlers, so a
// re-added server with the same id needs its relay hooks re-applied. The
// manager keeps handlers in a Set, so re-adding the SAME function instance
// is an idempotent no-op while the server stays registered.
const relayDispatchers = new Map<string, Map<string, (n: any) => void>>();

function pushFrameToClient(
  serverId: string,
  frame: Record<string, unknown>
): void {
  const relays = notificationRelays.get(serverId);
  if (!relays || relays.size === 0) {
    return;
  }
  const payload = JSON.stringify(frame);
  for (const push of relays) {
    try {
      push(payload);
    } catch {}
  }
}

function ensureNotificationRelay(clientManager: any, serverId: string): void {
  let dispatchers = relayDispatchers.get(serverId);
  if (!dispatchers) {
    dispatchers = new Map();
    for (const method of RELAYED_NOTIFICATION_METHODS) {
      dispatchers.set(method, (notification: any) => {
        pushFrameToClient(serverId, {
          jsonrpc: "2.0",
          method: notification?.method ?? method,
          params: notification?.params,
        });
      });
    }
    relayDispatchers.set(serverId, dispatchers);
  }
  // Register on every SSE open (not once per process): restores the hooks
  // after removeServer() wiped them, dedupes via the manager's handler Set
  // otherwise.
  for (const [method, handler] of dispatchers) {
    try {
      clientManager.addNotificationHandler(serverId, method as any, handler);
    } catch {
      // Server may not support handler registration yet; the manager
      // re-applies stored handlers when the client (re)connects.
    }
  }
}

// ── Tunnel awareness ────────────────────────────────────────────────────────

function forwardedTunnelHost(c: any): string | undefined {
  const xfHost = c.req.header("x-forwarded-host");
  if (!xfHost || !isActiveTunnelDomain(xfHost)) {
    return undefined;
  }
  return String(xfHost).toLowerCase().split(":")[0];
}

/**
 * Per-server isolation guard (defense-in-depth behind the ngrok Traffic
 * Policy path rule): a request that arrived through a per-server tunnel may
 * only address the serverId that tunnel was provisioned for.
 */
function tunnelScopeViolation(c: any, requestedServerId: string): boolean {
  const tunnelHost = forwardedTunnelHost(c);
  if (!tunnelHost) {
    return false;
  }
  const boundServerId = getServerIdForTunnelDomain(tunnelHost);
  if (!boundServerId) {
    // Legacy shared tunnel — no per-server binding to enforce.
    return false;
  }
  return boundServerId.toLowerCase() !== requestedServerId.toLowerCase();
}

function logTunnelRequest(
  c: any,
  serverId: string,
  rpcMethod: string | undefined
): void {
  if (!forwardedTunnelHost(c)) {
    return;
  }
  recordTunnelRequest(serverId, { method: rpcMethod, path: c.req.path });
  try {
    getRequestLogger(c, "routes.mcp.http-adapters").event("tunnel.request", {
      tunnelKind: "server",
      rpcMethod,
      path: c.req.path,
    });
  } catch {}
}

function normalizeServerId(clientManager: any, serverId: string): string {
  const availableServers = clientManager
    .listServers()
    // `getClient()` is legacy-only. Use `getManagedClient()` so stateless
    // preview connections show up in the available-servers list.
    .filter((id: string) => Boolean(clientManager.getManagedClient(id)));

  if (availableServers.includes(serverId)) {
    return serverId;
  }
  const match = availableServers.find(
    (name: string) => name.toLowerCase() === serverId.toLowerCase()
  );
  return match ?? serverId;
}

// Unified HTTP adapter that handles both adapter-http and manager-http routes
// with the same robust implementation but different JSON-RPC response modes

function createHttpHandler(mode: BridgeMode, routePrefix: string) {
  const router = new Hono();

  // CORS preflight is handled by the global CORS middleware in server/index.ts
  // These OPTIONS handlers just return 204 to complete the preflight
  router.options("/:serverId", (c) => c.body(null, 204));

  // Wildcard variants to tolerate trailing paths (e.g., /mcp)
  router.options("/:serverId/*", (c) => c.body(null, 204));

  async function handleHttp(c: any) {
    const serverId = c.req.param("serverId");
    const method = c.req.method;

    // A per-server tunnel must not reach any other server's adapter.
    if (tunnelScopeViolation(c, serverId)) {
      return c.json({ error: "Not found" }, 404);
    }

    // SSE endpoint for clients that probe/subscribe via GET; HEAD advertises event-stream
    if (method === "HEAD") {
      return c.body(null, 200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
    }
    if (method === "GET") {
      const encoder = new TextEncoder();
      const incomingUrl = new URL(c.req.url);
      // Allow proxy to override the endpoint base so the client posts back through the proxy
      const overrideBase = c.req.header("x-mcpjam-endpoint-base");
      let endpointBase: string;
      if (overrideBase && overrideBase.trim() !== "") {
        endpointBase = overrideBase.trim();
      } else {
        // Compute an absolute endpoint based on forwarded headers when present
        // so direct access (without the proxy) advertises a reachable URL.
        const xfProto = c.req.header("x-forwarded-proto");
        const xfHost = c.req.header("x-forwarded-host");
        const rawHost = c.req.header("host");
        const host = xfHost || rawHost;
        let proto = xfProto;
        if (!proto) {
          const originHeader = c.req.header("origin");
          if (originHeader && /^https:/i.test(originHeader)) proto = "https";
        }
        if (!proto) proto = "http";
        const origin = host ? `${proto}://${host}` : incomingUrl.origin;
        endpointBase = `${origin}/api/mcp/${routePrefix}/${serverId}/messages`;
      }
      // Propagate the tunnel bearer secret into the advertised endpoint:
      // SSE clients POST to this URL verbatim, and without ?k= the ngrok
      // edge policy would 401 their messages.
      const incomingSecret = incomingUrl.searchParams.get("k");
      if (incomingSecret && !/[?&]k=/.test(endpointBase)) {
        const sep = endpointBase.includes("?") ? "&" : "?";
        endpointBase = `${endpointBase}${sep}k=${encodeURIComponent(
          incomingSecret
        )}`;
      }
      const sessionId = crypto.randomUUID();
      const relayServerId = normalizeServerId(c.mcpClientManager, serverId);
      let relayPush: ((payload: string) => void) | undefined;
      let timer: any;
      const stream = new ReadableStream({
        start(controller) {
          const send = (event: string, data: string) => {
            controller.enqueue(encoder.encode(`event: ${event}\n`));
            controller.enqueue(encoder.encode(`data: ${data}\n\n`));
          };
          const close = () => {
            try {
              controller.close();
            } catch {}
          };

          // Register session
          sessions.set(`${serverId}:${sessionId}`, { send, close });
          latestSessionByServer.set(serverId, sessionId);

          // Relay real server notifications down this SSE stream.
          relayPush = (payload: string) => send("message", payload);
          let relaySet = notificationRelays.get(relayServerId);
          if (!relaySet) {
            relaySet = new Set();
            notificationRelays.set(relayServerId, relaySet);
          }
          relaySet.add(relayPush);
          ensureNotificationRelay(c.mcpClientManager, relayServerId);

          // Ping and endpoint per SSE transport handshake
          send("ping", "");
          const sep = endpointBase.includes("?") ? "&" : "?";
          const url = `${endpointBase}${sep}sessionId=${sessionId}`;
          // Emit endpoint as JSON (spec-friendly) then as a plain string (compat).
          try {
            send("endpoint", JSON.stringify({ url, headers: {} }));
          } catch {}
          try {
            send("endpoint", url);
          } catch {}

          // Periodic keepalive comments so proxies don't buffer/close
          timer = setInterval(() => {
            try {
              controller.enqueue(
                encoder.encode(`: keepalive ${Date.now()}\n\n`)
              );
            } catch {}
          }, 15000);
        },
        cancel() {
          try {
            clearInterval(timer);
          } catch {}
          sessions.delete(`${serverId}:${sessionId}`);
          // If this session was the latest for this server, clear pointer
          if (latestSessionByServer.get(serverId) === sessionId) {
            latestSessionByServer.delete(serverId);
          }
          // Drop this stream from the notification relay set
          if (relayPush) {
            const relaySet = notificationRelays.get(relayServerId);
            relaySet?.delete(relayPush);
            if (relaySet && relaySet.size === 0) {
              notificationRelays.delete(relayServerId);
            }
          }
        },
      });
      return c.body(stream as any, 200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "Transfer-Encoding": "chunked",
      });
    }

    if (method !== "POST") {
      return c.json({ error: "Unsupported request" }, 400);
    }

    // Parse JSON body (best effort)
    let body: any = undefined;
    try {
      body = await c.req.json();
    } catch {}

    const clientManager = c.mcpClientManager;

    // Normalize serverId - try to find a case-insensitive match if exact match fails
    const normalizedServerId = normalizeServerId(clientManager, serverId);

    logTunnelRequest(c, normalizedServerId, body?.method);

    const response = await handleJsonRpc(
      normalizedServerId,
      body as any,
      clientManager,
      mode
    );
    if (!response) {
      // Notification → 202 Accepted
      return c.body("Accepted", 202);
    }
    return c.json(response);
  }

  // Endpoint to receive client messages for SSE transport: /:serverId/messages?sessionId=...
  router.post("/:serverId/messages", async (c) => {
    const serverId = c.req.param("serverId");

    // A per-server tunnel must not reach any other server's adapter.
    if (tunnelScopeViolation(c, serverId)) {
      return c.json({ error: "Not found" }, 404);
    }

    const url = new URL(c.req.url);
    const sessionId = url.searchParams.get("sessionId") || "";
    const key = `${serverId}:${sessionId}`;
    let sess = sessions.get(key);
    if (!sess) {
      const fallbackId = latestSessionByServer.get(serverId);
      if (fallbackId) {
        sess = sessions.get(`${serverId}:${fallbackId}`);
      }
    }
    if (!sess) {
      return c.json({ error: "Invalid session" }, 400);
    }
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      try {
        const txt = await c.req.text();
        body = txt ? JSON.parse(txt) : undefined;
      } catch {
        body = undefined;
      }
    }
    const id = body?.id ?? null;
    const method = body?.method as string | undefined;
    const params = body?.params ?? {};

    // Normalize serverId - try to find a case-insensitive match if exact match fails
    const normalizedServerId = normalizeServerId(c.mcpClientManager, serverId);

    logTunnelRequest(c, normalizedServerId, method);

    // Reuse the JSON-RPC handling via bridge
    try {
      const responseMessage = await handleJsonRpc(
        normalizedServerId,
        { id, method, params },
        c.mcpClientManager,
        mode
      );
      // If there is a JSON-RPC response, emit it over SSE to the client
      if (responseMessage) {
        try {
          sess.send("message", JSON.stringify(responseMessage));
        } catch {}
      }
      // 202 Accepted per SSE transport semantics
      return c.body("Accepted", 202);
    } catch (e: any) {
      return c.body("Error", 400);
    }
  });

  // Register catch-all handlers AFTER the messages route so it isn't shadowed
  router.all("/:serverId", handleHttp);
  router.all("/:serverId/*", handleHttp);

  return router;
}

// Create both adapters with their respective modes
export const adapterHttp = createHttpHandler("adapter", "adapter-http");
export const managerHttp = createHttpHandler("manager", "manager-http");

// Export default for backward compatibility (adapter)
export default adapterHttp;
