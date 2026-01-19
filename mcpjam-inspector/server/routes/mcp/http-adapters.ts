import { Hono } from "hono";
import "../../types/hono";
import { handleJsonRpc, BridgeMode } from "../../services/mcp-http-bridge";

// In-memory SSE session store per serverId:sessionId
type Session = {
  send: (event: string, data: string) => void;
  close: () => void;
};
const sessions: Map<string, Session> = new Map();
const latestSessionByServer: Map<string, string> = new Map();

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
      const sessionId = crypto.randomUUID();
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
                encoder.encode(`: keepalive ${Date.now()}\n\n`),
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
    let normalizedServerId = serverId;
    const availableServers = clientManager
      .listServers()
      .filter((id: string) => Boolean(clientManager.getClient(id)));

    if (!availableServers.includes(serverId)) {
      const match = availableServers.find(
        (name: string) => name.toLowerCase() === serverId.toLowerCase(),
      );
      if (match) {
        normalizedServerId = match;
      }
    }

    const response = await handleJsonRpc(
      normalizedServerId,
      body as any,
      clientManager,
      mode,
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
    let normalizedServerId = serverId;
    const availableServers = c.mcpClientManager
      .listServers()
      .filter((id: string) => Boolean(c.mcpClientManager.getClient(id)));

    if (!availableServers.includes(serverId)) {
      const match = availableServers.find(
        (name: string) => name.toLowerCase() === serverId.toLowerCase(),
      );
      if (match) {
        normalizedServerId = match;
      }
    }

    // Reuse the JSON-RPC handling via bridge
    try {
      const responseMessage = await handleJsonRpc(
        normalizedServerId,
        { id, method, params },
        c.mcpClientManager,
        mode,
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
