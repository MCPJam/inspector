import { Hono } from "hono";
import { interceptorStore } from "../../services/interceptor-store";

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
  // Avoid CL+TE conflicts in dev proxies: prefer chunked framing decided by runtime
  headers.delete("content-length");
  headers.delete("Content-Length");
  headers.delete("transfer-encoding");
  headers.delete("Transfer-Encoding");
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

function maskHeaders(orig: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  orig.forEach((value, key) => {
    if (key.toLowerCase() === "authorization") {
      out[key] = value.startsWith("Bearer ") ? "Bearer ***" : "***";
    } else {
      out[key] = value;
    }
  });
  return out;
}

// Create interceptor pointing to a target MCP server (HTTP)
interceptor.post("/create", async (c) => {
  try {
    const body = await c.req.json();
    const targetUrl = body?.targetUrl as string | undefined;
    // Back-compat: accept `serverId` or legacy `managerServerId`
    const serverId: string | undefined =
      (body?.serverId as string | undefined) ||
      (body?.managerServerId as string | undefined);
    const urlObj = new URL(c.req.url);
    let finalTarget: string | undefined = targetUrl;
    let injectHeaders: Record<string, string> | undefined;

    if (serverId) {
      // Use stored config for a connected server to derive headers and possibly URL
      const connected = c.mcpJamClientManager.getConnectedServers();
      const serverMeta = connected[serverId];
      const cfg: any | undefined = serverMeta?.config;
      if (!cfg || serverMeta?.status !== "connected") {
        return c.json(
          { success: false, error: `Server '${serverId}' is not connected` },
          400,
        );
      }
      if (!finalTarget) {
        if (cfg.url) {
          finalTarget =
            typeof cfg.url === "string" ? cfg.url : (cfg.url as URL).toString();
        } else {
          const origin = new URL(c.req.url).origin;
          finalTarget = `${origin}/api/mcp/adapter-http/${encodeURIComponent(serverId)}`;
        }
      }
      // Derive Authorization and custom headers
      const hdrs: Record<string, string> = {};
      const fromReqInit = cfg.requestInit?.headers as
        | Record<string, string>
        | undefined;
      if (fromReqInit) {
        for (const [k, v] of Object.entries(fromReqInit)) {
          if (typeof v === "string") hdrs[k.toLowerCase()] = v;
        }
      }
      const token: string | undefined =
        cfg?.oauth?.access_token || cfg?.oauth?.accessToken;
      if (token && !hdrs["authorization"]) {
        hdrs["authorization"] = `Bearer ${token}`;
        hdrs["Authorization"] = `Bearer ${token}`; // be generous with casing
      }
      injectHeaders = hdrs;
    }

    if (!finalTarget) {
      return c.json(
        { success: false, error: "targetUrl or serverId is required" },
        400,
      );
    }
    try {
      const u = new URL(finalTarget);
      if (!["http:", "https:"].includes(u.protocol)) {
        return c.json(
          {
            success: false,
            error: "Only HTTP/HTTPS MCP servers are supported",
          },
          400,
        );
      }
    } catch {
      return c.json({ success: false, error: "Invalid URL" }, 400);
    }

    const entry = interceptorStore.create(finalTarget, injectHeaders, serverId);

    // Compute local origin and optional public HTTPS origin via tunnel
    const localOrigin = urlObj.origin;
    // Tunneling disabled: always advertise local origin only
    const publicOrigin: string | null = null;

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
  // HTTP-only mode: do not surface tunnel URL here
  const publicOrigin = null;
  const proxyPath = `/api/mcp/interceptor/${id}/proxy`;
  const localProxyUrl = `${urlObj.origin}${proxyPath}`;
  const publicProxyUrl = publicOrigin ? `${publicOrigin}${proxyPath}` : null;
  const proxyUrl = publicProxyUrl || localProxyUrl;
  return c.json({
    success: true,
    ...info,
    proxyUrl,
    localProxyUrl,
    publicProxyUrl,
  });
});

// Clear logs
interceptor.post("/:id/clear", (c) => {
  const id = c.req.param("id");
  const ok = interceptorStore.clearLogs(id);
  if (!ok) return c.json({ success: false, error: "not found" }, 404);
  return c.json({ success: true });
});

// Destroy interceptor (stop proxy)
interceptor.delete("/:id", (c) => {
  const id = c.req.param("id");
  const ok = interceptorStore.destroy(id);
  if (!ok) return c.json({ success: false, error: "not found" }, 404);
  return c.json({ success: true });
});

// Destroy all interceptors created for a connected server
interceptor.delete("/by-server/:serverId", (c) => {
  const serverId = c.req.param("serverId");
  const count = interceptorStore.destroyByServer(serverId);
  return c.json({ success: true, count });
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
      "Access-Control-Allow-Headers":
        "*, Authorization, Content-Type, Accept, Accept-Language",
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
    headers: maskHeaders(req.headers),
    body: requestBody,
  });

  // Shim SSE for stateless servers (Cursor compatibility):
  try {
    const accept = (req.headers.get("accept") || "").toLowerCase();
    const wantsSSE = accept.includes("text/event-stream");
    const targetPathname = new URL(entry.targetUrl).pathname;
    const upstreamLooksLikeSse = /\/sse(\/|$)/i.test(targetPathname);
    if (req.method === "HEAD" && wantsSSE && !upstreamLooksLikeSse) {
      const headers = new Headers({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      headers.delete("content-length");
      headers.delete("Content-Length");
      headers.delete("transfer-encoding");
      headers.delete("Transfer-Encoding");
      return withCORS(new Response(null, { status: 200, headers }));
    }
    if (req.method === "GET" && wantsSSE && !upstreamLooksLikeSse) {
      const xfProto = req.headers.get("x-forwarded-proto");
      const xfHost = req.headers.get("x-forwarded-host");
      const host = xfHost || req.headers.get("host");
      let proto = xfProto;
      if (!proto) {
        const originHeader = req.headers.get("origin");
        if (originHeader && /^https:/i.test(originHeader)) proto = "https";
      }
      if (!proto) proto = "http";
      const proxyOrigin = host ? `${proto}://${host}` : new URL(req.url).origin;
      const sessionId = crypto.randomUUID();
      // Map session to upstream base URL (stateless POST endpoint)
      interceptorStore.setSessionEndpoint(
        id,
        sessionId,
        new URL(entry.targetUrl).toString(),
      );
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`event: ping\n`));
          controller.enqueue(encoder.encode(`data: \n\n`));
          const endpoint = `${proxyOrigin}/api/mcp/interceptor/${id}/proxy/messages?sessionId=${sessionId}`;
          // Some clients (Cursor) expect JSON {url: ...}; others (Claude) choke on JSON and use string.
          const ua = c.req.header("user-agent") || "";
          const isClaude = /claude/i.test(ua) || /anthropic/i.test(ua);
          if (!isClaude) {
            controller.enqueue(encoder.encode(`event: endpoint\n`));
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ url: endpoint })}\n\n`),
            );
          }
          controller.enqueue(encoder.encode(`event: endpoint\n`));
          controller.enqueue(encoder.encode(`data: ${endpoint}\n\n`));
          const t = setInterval(() => {
            try {
              controller.enqueue(
                encoder.encode(`: keepalive ${Date.now()}\n\n`),
              );
            } catch {}
          }, 15000);
          (controller as any)._t = t;
        },
        cancel() {
          try {
            clearInterval((this as any)._t);
          } catch {}
        },
      });
      {
        const headers = new Headers({
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        // Ensure no CL/TE conflict for dev proxies
        headers.delete("content-length");
        headers.delete("Content-Length");
        headers.delete("transfer-encoding");
        headers.delete("Transfer-Encoding");
        return withCORS(new Response(stream as any, { headers }));
      }
    }
  } catch {}

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
    // Special-case: if this is our rewritten messages endpoint, forward to the original upstream endpoint
    if (trailing.startsWith("/messages")) {
      const sessionId = new URL(req.url).searchParams.get("sessionId") || "";
      const mapped = sessionId
        ? interceptorStore.getSessionEndpoint(id, sessionId)
        : undefined;
      if (mapped) {
        upstreamUrl = new URL(mapped);
      } else {
        // Stateless fallback: POST to upstream base URL (drop /messages path and local query)
        upstreamUrl.pathname = `${basePath}`;
        upstreamUrl.search = "";
      }
    } else {
      upstreamUrl.pathname = `${basePath}${trailing}`;
      // Preserve target URL's query parameters (e.g., API keys) and merge with request params
      const targetParams = new URLSearchParams(upstreamUrl.search);
      const requestParams = new URLSearchParams(originalUrl.search);
      // Add request params to target params (target params take precedence)
      requestParams.forEach((value, key) => {
        if (!targetParams.has(key)) {
          targetParams.set(key, value);
        }
      });
      upstreamUrl.search = targetParams.toString();
    }
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

  // Ensure Accept advertises both JSON and SSE for servers that require it (e.g., HF/Cloudflare)
  try {
    const acc = (filtered.get("accept") || "").toLowerCase();
    const hasJson = acc.includes("application/json");
    const hasSse = acc.includes("text/event-stream");
    if (!hasJson || !hasSse) {
      const parts: string[] = [];
      if (!hasJson) parts.push("application/json");
      if (!hasSse) parts.push("text/event-stream");
      const suffix = parts.join(", ");
      filtered.set("accept", acc ? `${acc}, ${suffix}` : suffix);
    }
  } catch {}

  // Inject static headers (e.g., Authorization) if not already present from the client
  if (entry.injectHeaders) {
    for (const [key, value] of Object.entries(entry.injectHeaders)) {
      const k = key.toLowerCase();
      if (k === "host" || k === "content-length") continue;
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
        continue;
      // Do not override an explicit client Authorization header
      if (k === "authorization" && filtered.has("authorization")) continue;
      filtered.set(key, value);
    }
  }

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
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    const isStreaming =
      ct.includes("text/event-stream") || ct.includes("application/x-ndjson");
    let responseBody: string | undefined;
    try {
      if (
        ct.includes("text/event-stream") ||
        ct.includes("application/x-ndjson")
      ) {
        responseBody = "[stream]"; // avoid draining the stream
      } else {
        responseBody = await resClone.text();
      }
    } catch {
      responseBody = undefined;
    }
    // For streaming responses, skip the placeholder log and rely on detailed SSE message logs
    if (!isStreaming) {
      interceptorStore.appendLog(id, {
        id: `${requestId}-res`,
        timestamp: Date.now(),
        direction: "response",
        status: res.status,
        statusText: res.statusText,
        headers: Object.fromEntries(res.headers.entries()),
        body: responseBody,
      });
    }
    // If this is an SSE stream, rewrite endpoint events to point back through the proxy
    if (ct.includes("text/event-stream")) {
      const upstreamBody = res.body;
      if (!upstreamBody) {
        return withCORS(
          new Response(null, { status: res.status, headers: res.headers }),
        );
      }
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      let buffer = "";
      let lastEventType: string | null = null;
      // Accumulate data lines for the current SSE event so we can log full payloads
      let currentEventData: string[] = [];
      const proxyBasePath = `/api/mcp/interceptor/${id}/proxy`;
      // Derive proxy origin from forwarded/host headers for direct access.
      const xfProto = c.req.header("x-forwarded-proto");
      const xfHost = c.req.header("x-forwarded-host");
      const reqHost = xfHost || c.req.header("host");
      let reqProto = xfProto;
      if (!reqProto) {
        const originHeader = c.req.header("origin");
        if (originHeader && /^https:/i.test(originHeader)) reqProto = "https";
      }
      if (!reqProto) reqProto = "http";
      const proxyOrigin = reqHost
        ? `${reqProto}://${reqHost}`
        : new URL(c.req.url).origin;
      // Prefer the resolved upstream response URL; fall back to request URL
      let upstreamOrigin = (() => {
        try {
          const u = new URL((res as any).url || upstreamUrl.toString());
          return `${u.protocol}//${u.host}`;
        } catch {
          try {
            return new URL(entry.targetUrl).origin;
          } catch {
            return "";
          }
        }
      })();
      const rewriteStream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const reader = upstreamBody.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              let idx: number;
              while ((idx = buffer.indexOf("\n")) !== -1) {
                const line = buffer.slice(0, idx + 1); // include newline
                buffer = buffer.slice(idx + 1);
                if (line.startsWith("event:")) {
                  lastEventType = line.slice(6).trim();
                  controller.enqueue(encoder.encode(line));
                } else if (line.startsWith("data:")) {
                  // Parse data lines for endpoint hints
                  const rawLine = line.slice(5); // keep trailing newline
                  const trimmed = rawLine.trim();
                  // Track data lines for this event so we can log at event boundary
                  currentEventData.push(trimmed);
                  let endpointUrl: string | null = null;
                  try {
                    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
                      const obj = JSON.parse(trimmed);
                      // Accept various shapes
                      endpointUrl =
                        obj?.url ||
                        obj?.endpoint?.url ||
                        (obj?.type === "endpoint" &&
                          (obj?.data?.url || obj?.data));
                    }
                  } catch {}
                  if (!endpointUrl) {
                    // Heuristic: plain string containing "/message" looks like endpoint URL
                    const str = trimmed;
                    if (/message\?/.test(str) || /messages\?/.test(str)) {
                      endpointUrl = str;
                    }
                  }
                  if (endpointUrl) {
                    try {
                      const u = new URL(
                        endpointUrl,
                        upstreamOrigin || undefined,
                      );
                      const sessionId =
                        u.searchParams.get("sessionId") ||
                        u.searchParams.get("sid") ||
                        "";
                      if (sessionId) {
                        interceptorStore.setSessionEndpoint(
                          id,
                          sessionId,
                          u.toString(),
                        );
                        try {
                          console.log("[proxy] mapped session", {
                            id,
                            sessionId,
                            upstream: u.toString(),
                          });
                        } catch {}
                      }
                      const proxyEndpoint = `${proxyOrigin}${proxyBasePath}/messages${u.search}`;
                      // Emit a single endpoint event with a plain string URL (most compatible)
                      controller.enqueue(encoder.encode(`event: endpoint\n`));
                      controller.enqueue(
                        encoder.encode(`data: ${proxyEndpoint}\n\n`),
                      );
                      // Reset current event buffer since we emitted a translated event
                      currentEventData = [];
                      continue; // skip original data line
                    } catch {
                      // fall through
                    }
                  }
                  // Not an endpoint payload; pass through
                  controller.enqueue(encoder.encode(line));
                } else if (line === "\n") {
                  // End of an SSE event — if it was a message event, mirror it into logs
                  if (lastEventType === "message") {
                    const dataText = currentEventData.join("\n");
                    let bodyText = dataText;
                    try {
                      // Many servers send a single JSON line; keep original text if parse fails
                      const parsed = JSON.parse(dataText);
                      bodyText = JSON.stringify(parsed);
                    } catch {}
                    try {
                      interceptorStore.appendLog(id, {
                        id: `${requestId}-sse-${Date.now()}`,
                        timestamp: Date.now(),
                        direction: "response",
                        status: 200,
                        statusText: "SSE message",
                        headers: { "content-type": "text/event-stream" },
                        body: bodyText,
                      });
                    } catch {}
                  }
                  currentEventData = [];
                  lastEventType = null;
                  controller.enqueue(encoder.encode(line));
                } else {
                  controller.enqueue(encoder.encode(line));
                }
              }
            }
            if (buffer.length) controller.enqueue(encoder.encode(buffer));
          } finally {
            try {
              controller.close();
            } catch {}
          }
        },
      });
      const headers = new Headers(res.headers);
      // For streaming responses, do not send Content-Length; Node will use chunked framing.
      headers.delete("content-length");
      headers.delete("Content-Length");
      // Let the runtime decide Transfer-Encoding; keep-alive semantics for SSE
      headers.delete("transfer-encoding");
      headers.delete("Transfer-Encoding");
      headers.set("Cache-Control", "no-cache");
      headers.set("Connection", "keep-alive");
      return withCORS(
        new Response(rewriteStream as any, {
          status: res.status,
          statusText: res.statusText,
          headers,
        }),
      );
    }

    // Non-SSE: passthrough (avoid CL+TE conflict) — always drop Content-Length
    const nonSseHeaders = new Headers(res.headers);
    nonSseHeaders.delete("content-length");
    nonSseHeaders.delete("Content-Length");
    const passthrough = new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: nonSseHeaders,
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
    return withCORS(
      new Response(body, {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }
}

// HTTP proxy for JSON-RPC
interceptor.all("/:id/proxy", handleProxy);
interceptor.all("/:id/proxy/*", handleProxy);

export default interceptor;
