import { Hono } from "hono";
import { interceptorStore } from "../../services/interceptor-store";

const interceptor = new Hono();

// Create interceptor pointing to a target MCP server (HTTP)
interceptor.post("/create", async (c) => {
  try {
    const { targetUrl, managerServerId } = await c.req.json();
    let finalTarget = targetUrl as string | undefined;

    // If a manager-backed server is provided, we don't need an external URL at all.
    if (managerServerId) {
      finalTarget = `manager://${managerServerId}`;
    }

    if (!finalTarget || typeof finalTarget !== "string") {
      return c.json({ success: false, error: "targetUrl is required when no managerServerId is provided" }, 400);
    }

    // Only validate when proxying raw HTTP
    if (!managerServerId) {
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
    }

    const entry = interceptorStore.create(finalTarget, managerServerId);

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

  // If manager-backed, route through MCPJamClientManager to reuse OAuth and server connection
  if (entry.managerServerId) {
    try {
      const { method } = req;
      const isJson = (req.headers.get("content-type") || "").includes("application/json");
      // Expect JSON-RPC
      let jsonBody: any = undefined;
      if (method !== "GET" && method !== "HEAD" && requestBody && isJson) {
        try { jsonBody = JSON.parse(requestBody); } catch {}
      }

      const clientManager = c.mcpJamClientManager;
      const serverId = entry.managerServerId;

      let upstreamResponse: Response;
      // Support plain GET to target root (some clients probe)
      if (method === "GET") {
        upstreamResponse = new Response("OK", { status: 200 });
      } else if (jsonBody && jsonBody.method) {
        // Minimal JSON-RPC bridge: initialize and tools.list can be emulated
        if (jsonBody.method === "initialize") {
          const result = {
            protocolVersion: "2025-06-18",
            capabilities: {
              tools: true,
              prompts: true,
              resources: true,
              logging: false,
              elicitation: {},
              roots: { listChanged: true },
            },
            serverInfo: { name: serverId, version: "mcpjam-proxy" },
          };
          upstreamResponse = new Response(JSON.stringify({ jsonrpc: "2.0", id: jsonBody.id ?? null, result }), { status: 200, headers: { "content-type": "application/json" } });
        } else if (jsonBody.method === "tools/list") {
          const toolsets = await clientManager.getToolsetsForServer(serverId);
          const tools = Object.keys(toolsets).map((name) => ({ name, description: (toolsets as any)[name].description }));
          upstreamResponse = new Response(JSON.stringify({ jsonrpc: "2.0", id: jsonBody.id ?? null, result: { tools } }), { status: 200, headers: { "content-type": "application/json" } });
        } else if (jsonBody.method === "tools/call" && jsonBody.params?.name) {
          try {
            const exec = await clientManager.executeToolDirect(`${serverId}:${jsonBody.params.name}`, jsonBody.params?.arguments || {});
            upstreamResponse = new Response(JSON.stringify({ jsonrpc: "2.0", id: jsonBody.id ?? null, result: exec.result }), { status: 200, headers: { "content-type": "application/json" } });
          } catch (e) {
            upstreamResponse = new Response(JSON.stringify({ jsonrpc: "2.0", id: jsonBody.id ?? null, error: { code: -32000, message: (e as Error).message } }), { status: 200, headers: { "content-type": "application/json" } });
          }
        } else {
          upstreamResponse = new Response(JSON.stringify({ jsonrpc: "2.0", id: jsonBody.id ?? null, error: { code: -32601, message: "Method not implemented in proxy" } }), { status: 200, headers: { "content-type": "application/json" } });
        }
      } else {
        upstreamResponse = new Response(JSON.stringify({ error: "Unsupported request" }), { status: 400, headers: { "content-type": "application/json" } });
      }

      // Log and return
      const resClone = upstreamResponse.clone();
      let responseBody: string | undefined;
      try { responseBody = await resClone.text(); } catch {}
      interceptorStore.appendLog(id, {
        id: `${requestId}-res`,
        timestamp: Date.now(),
        direction: "response",
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText || "",
        headers: Object.fromEntries(upstreamResponse.headers.entries()),
        body: responseBody,
      });
      return upstreamResponse;
    } catch (e) {
      const body = JSON.stringify({ error: String(e) });
      interceptorStore.appendLog(id, {
        id: `${requestId}-err`,
        timestamp: Date.now(),
        direction: "response",
        status: 500,
        statusText: "Proxy Error",
        headers: { "content-type": "application/json" },
        body,
      });
      return new Response(body, { status: 500, headers: { "Content-Type": "application/json" } });
    }
  }

  // Standard HTTP target proxy path
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


