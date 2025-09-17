import { Hono } from "hono";
import { interceptorStore } from "../../services/interceptor-store";
import { ensureNgrokTunnel, getNgrokUrl } from "../../services/ngrok";

const interceptor = new Hono();

// Helper to add permissive CORS headers for public proxy endpoints
function withCORS(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET,POST,HEAD,OPTIONS");
  // Be explicit: some clients won’t accept "*" for Authorization
  headers.set(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Accept, Accept-Language",
  );
  headers.set("Access-Control-Expose-Headers", "*");
  headers.set("Vary", "Origin, Access-Control-Request-Headers");
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

// Create interceptor pointing to a target MCP server (HTTP)
interceptor.post("/create", async (c) => {
  try {
    const { targetUrl } = await c.req.json();
    const urlObj = new URL(c.req.url);
    const useTunnel = urlObj.searchParams.get("tunnel") === "true";
    const finalTarget = typeof targetUrl === "string" ? targetUrl : undefined;
    if (!finalTarget) {
      return c.json({ success: false, error: "targetUrl is required" }, 400);
    }
    try {
      const u = new URL(finalTarget);
      if (!["http:", "https:"].includes(u.protocol)) {
        return c.json(
          { success: false, error: "Only HTTP/HTTPS MCP servers are supported" },
          400,
        );
      }
    } catch {
      return c.json({ success: false, error: "Invalid URL" }, 400);
    }

    const entry = interceptorStore.create(finalTarget);

    // Compute local origin and optional public HTTPS origin via tunnel
    const localOrigin = urlObj.origin;
    let publicOrigin: string | null = null;
    if (useTunnel) {
      // Always tunnel to the Node API port, not the Vite dev server.
      const port = parseInt(process.env.PORT || "3000", 10) || 3000;
      try {
        publicOrigin = await ensureNgrokTunnel(port);
      } catch {}
    } else {
      publicOrigin = getNgrokUrl();
    }

    const proxyPath = `/api/mcp/interceptor/${entry.id}/proxy`;
    const localProxyUrl = `${localOrigin}${proxyPath}`;
    const publicProxyUrl = publicOrigin ? `${publicOrigin}${proxyPath}` : null;
    // Prefer HTTPS tunnel when available for backward-compatible proxyUrl consumers
    const proxyUrl = publicProxyUrl || localProxyUrl;

    return c.json({
      success: true,
      id: entry.id,
      targetUrl: entry.targetUrl,
      proxyUrl,
      localProxyUrl,
      publicProxyUrl,
    });
  } catch (err) {
    return c.json(
      { success: false, error: (err as Error)?.message || "Invalid JSON" },
      400,
    );
  }
});

// Info
interceptor.get("/:id", (c) => {
  const id = c.req.param("id");
  const info = interceptorStore.info(id);
  if (!info) return c.json({ success: false, error: "not found" }, 404);
  const urlObj = new URL(c.req.url);
  const publicOrigin = getNgrokUrl();
  const proxyPath = `/api/mcp/interceptor/${id}/proxy`;
  const localProxyUrl = `${urlObj.origin}${proxyPath}`;
  const publicProxyUrl = publicOrigin ? `${publicOrigin}${proxyPath}` : null;
  const proxyUrl = publicProxyUrl || localProxyUrl;
  return c.json({ success: true, ...info, proxyUrl, localProxyUrl, publicProxyUrl });
});

// Clear logs
interceptor.post("/:id/clear", (c) => {
  const id = c.req.param("id");
  const ok = interceptorStore.clearLogs(id);
  if (!ok) return c.json({ success: false, error: "not found" }, 404);
  return c.json({ success: true });
});

// SSE stream of logs
interceptor.get("/:id/stream", (c) => {
  const id = c.req.param("id");
  const entry = interceptorStore.get(id);
  if (!entry) return c.json({ success: false, error: "not found" }, 404);

  const encoder = new TextEncoder();
  let unsubscribeFn: undefined | (() => void);
  const stream = new ReadableStream({
    start(controller) {
      // send history first
      for (const log of entry.logs) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "log", log })}\n\n`),
        );
      }
      const subscriber = {
        send: (event: any) => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        },
        close: () => controller.close(),
      };
      const unsubscribe = interceptorStore.subscribe(id, subscriber);
      unsubscribeFn = unsubscribe;
    },
    cancel() {
      try {
        unsubscribeFn && unsubscribeFn();
      } catch {}
    },
  });
  return new Response(stream as any, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,HEAD,OPTIONS",
      "Access-Control-Allow-Headers": "*, Authorization, Content-Type, Accept, Accept-Language",
      "X-Accel-Buffering": "no",
    },
  });
});

// CORS preflight for proxy endpoint
interceptor.options("/:id/proxy", (c) => {
  return c.body(null, 204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,HEAD,OPTIONS",
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, Accept, Accept-Language",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin, Access-Control-Request-Headers",
  });
});

// Also handle preflight on wildcard path
interceptor.options("/:id/proxy/*", (c) => {
  return c.body(null, 204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,HEAD,OPTIONS",
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, Accept, Accept-Language",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin, Access-Control-Request-Headers",
  });
});

async function handleProxy(c: any) {
  const id = c.req.param("id");
  const entry = interceptorStore.get(id);
  if (!entry) return c.json({ success: false, error: "not found" }, 404);

  const req = c.req.raw;
  const requestId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // read request body text safely
  let requestBody: string | undefined;
  try {
    const clone = req.clone();
    requestBody = await clone.text();
  } catch {
    requestBody = undefined;
  }

  // log request
  interceptorStore.appendLog(id, {
    id: requestId,
    timestamp: Date.now(),
    direction: "request",
    method: req.method,
    url: entry.targetUrl,
    headers: Object.fromEntries(req.headers.entries()),
    body: requestBody,
  });

  // Build upstream URL: preserve trailing path (/messages etc.) and query after /proxy/:id
  let upstreamUrl = new URL(entry.targetUrl);
  try {
    const originalUrl = new URL(req.url);
    const proxyBase = `/api/mcp/interceptor/${id}/proxy`;
    const rest = originalUrl.pathname.startsWith(proxyBase)
      ? originalUrl.pathname.slice(proxyBase.length)
      : "";
    const basePath = upstreamUrl.pathname.endsWith("/")
      ? upstreamUrl.pathname.slice(0, -1)
      : upstreamUrl.pathname;
    const trailing = rest ? (rest.startsWith("/") ? rest : `/${rest}`) : "";
    upstreamUrl.pathname = `${basePath}${trailing}`;
    upstreamUrl.search = originalUrl.search;
  } catch {}

  // Filter hop-by-hop headers and forward Authorization. Drop content-length so Undici computes it.
  const filtered = new Headers();
  req.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (
      [
        "connection",
        "keep-alive",
        "transfer-encoding",
        "upgrade",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
      ].includes(k)
    )
      return;
    if (k === "content-length") return;
    // Let fetch set the correct Host for the upstream
    if (k === "host") return;
    filtered.set(key, value);
  });

  // No manager-backed mode: pure proxy only

  const init: RequestInit = {
    method: req.method,
    headers: filtered,
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = requestBody;
  }
  const targetReq = new Request(upstreamUrl.toString(), init as any);

  try {
    const res = await fetch(targetReq);
    const resClone = res.clone();
    let responseBody: string | undefined;
    try {
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      if (ct.includes("text/event-stream") || ct.includes("application/x-ndjson")) {
        responseBody = "[stream]"; // avoid draining the stream
      } else {
        responseBody = await resClone.text();
      }
    } catch {
      responseBody = undefined;
    }
    interceptorStore.appendLog(id, {
      id: `${requestId}-res`,
      timestamp: Date.now(),
      direction: "response",
      status: res.status,
      statusText: res.statusText,
      headers: Object.fromEntries(res.headers.entries()),
      body: responseBody,
    });
    // Wrap in a fresh Response so downstream middleware (e.g., CORS) can mutate headers
    const passthrough = new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: new Headers(res.headers),
    });
    return withCORS(passthrough);
  } catch (error) {
    const body = JSON.stringify({ error: String(error) });
    interceptorStore.appendLog(id, {
      id: `${requestId}-err`,
      timestamp: Date.now(),
      direction: "response",
      status: 500,
      statusText: "Proxy Error",
      headers: { "content-type": "application/json" },
      body,
    });
    return withCORS(new Response(body, { status: 500, headers: { "Content-Type": "application/json" } }));
  }
}

// HTTP proxy for JSON-RPC
interceptor.all("/:id/proxy", handleProxy);
interceptor.all("/:id/proxy/*", handleProxy);

export default interceptor;
