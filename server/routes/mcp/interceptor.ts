import { Hono } from "hono";
import { interceptorStore } from "../../services/interceptor-store";

const interceptor = new Hono();

// Create interceptor pointing to a target MCP server (HTTP)
interceptor.post("/create", async (c) => {
  try {
    const { targetUrl } = await c.req.json();
    if (!targetUrl || typeof targetUrl !== "string") {
      return c.json({ success: false, error: "targetUrl is required" }, 400);
    }
    try {
      // Validate URL
      const u = new URL(targetUrl);
      if (!["http:", "https:"].includes(u.protocol)) {
        return c.json(
          { success: false, error: "Only HTTP/HTTPS MCP servers are supported" },
          400,
        );
      }
    } catch {
      return c.json({ success: false, error: "Invalid URL" }, 400);
    }

    const entry = interceptorStore.create(targetUrl);

    return c.json({
      success: true,
      id: entry.id,
      targetUrl: entry.targetUrl,
      proxyUrl: `${new URL(c.req.url).origin}/api/mcp/interceptor/${entry.id}/proxy`,
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
  return c.json({ success: true, ...info });
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
      (controller as any)._unsubscribe = unsubscribe;
    },
    cancel() {
      const unsubscribe = (this as any)._unsubscribe as undefined | (() => void);
      try {
        unsubscribe && unsubscribe();
      } catch {}
    },
  });
  return new Response(stream as any, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

// HTTP proxy for JSON-RPC
interceptor.all("/:id/proxy", async (c) => {
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

  // forward to target (no body for GET/HEAD)
  const init: RequestInit = {
    method: req.method,
    headers: req.headers as any,
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = requestBody;
  }
  const targetReq = new Request(entry.targetUrl, init as any);

  try {
    const res = await fetch(targetReq);
    const resClone = res.clone();
    let responseBody: string | undefined;
    try {
      responseBody = await resClone.text();
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
    return passthrough;
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
    return new Response(body, {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

export default interceptor;


