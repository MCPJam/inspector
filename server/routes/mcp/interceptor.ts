import { Hono } from "hono";
import { interceptorStore } from "../../services/interceptor-store";
import { ensureNgrokTunnel, getNgrokUrl } from "../../services/ngrok";

const interceptor = new Hono();

// Create interceptor pointing to a target MCP server (HTTP)
interceptor.post("/create", async (c) => {
  try {
    const { targetUrl, managerServerId } = await c.req.json();
    const urlObj = new URL(c.req.url);
    const useTunnel = urlObj.searchParams.get("tunnel") === "true";
    let finalTarget = targetUrl as string | undefined;
    // Normalize manager id: ignore empty or 'none'
    const mgrId =
      typeof managerServerId === "string" && managerServerId.trim() !== "" && managerServerId !== "none"
        ? managerServerId
        : undefined;

    // If a manager-backed server is provided, we don't need an external URL at all.
    if (mgrId) {
      // Validate the server is connected before accepting
      const status = c.mcpJamClientManager.getConnectionStatus(mgrId);
      if (status !== "connected") {
        return c.json(
          { success: false, error: `Manager server '${mgrId}' is not connected` },
          400,
        );
      }
      finalTarget = `manager://${mgrId}`;
    }

    if (!finalTarget || typeof finalTarget !== "string") {
      return c.json({ success: false, error: "targetUrl is required when no managerServerId is provided" }, 400);
    }

    // Only validate when proxying raw HTTP
    if (!mgrId) {
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

    const entry = interceptorStore.create(finalTarget, mgrId);

    // Compute local origin and optional public HTTPS origin via tunnel
    const localOrigin = urlObj.origin;
    let publicOrigin: string | null = null;
    if (useTunnel) {
      // derive port from local origin; default to 3000
      const portStr = urlObj.port || "3000";
      const port = parseInt(portStr || "3000", 10) || 3000;
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
      // Support plain GET/HEAD to target root (some clients probe)
      if (method === "GET" || method === "HEAD") {
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
          const tools = Object.keys(toolsets).map((name) => ({
            name,
            description: (toolsets as any)[name].description,
            inputSchema: (toolsets as any)[name].inputSchema,
            outputSchema: (toolsets as any)[name].outputSchema,
          }));
          upstreamResponse = new Response(
            JSON.stringify({ jsonrpc: "2.0", id: jsonBody.id ?? null, result: { tools } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        } else if (jsonBody.method === "tools/call" && jsonBody.params?.name) {
          try {
            const exec = await clientManager.executeToolDirect(`${serverId}:${jsonBody.params.name}`, jsonBody.params?.arguments || {});
            upstreamResponse = new Response(JSON.stringify({ jsonrpc: "2.0", id: jsonBody.id ?? null, result: exec.result }), { status: 200, headers: { "content-type": "application/json" } });
          } catch (e) {
            upstreamResponse = new Response(JSON.stringify({ jsonrpc: "2.0", id: jsonBody.id ?? null, error: { code: -32000, message: (e as Error).message } }), { status: 200, headers: { "content-type": "application/json" } });
          }
        } else if (jsonBody.method === "resources/list") {
          const resources = clientManager
            .getResourcesForServer(serverId)
            .map((r) => ({
              uri: r.uri,
              name: r.name,
              description: r.description,
              mimeType: r.mimeType,
            }));
          upstreamResponse = new Response(
            JSON.stringify({ jsonrpc: "2.0", id: jsonBody.id ?? null, result: { resources } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        } else if (jsonBody.method === "resources/read" && jsonBody.params?.uri) {
          try {
            const content = await clientManager.getResource(jsonBody.params.uri, serverId);
            upstreamResponse = new Response(
              JSON.stringify({ jsonrpc: "2.0", id: jsonBody.id ?? null, result: content }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          } catch (e) {
            upstreamResponse = new Response(
              JSON.stringify({ jsonrpc: "2.0", id: jsonBody.id ?? null, error: { code: -32000, message: (e as Error).message } }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
        } else if (jsonBody.method === "prompts/list") {
          const prompts = clientManager
            .getPromptsForServer(serverId)
            .map((p) => ({ name: p.name, description: p.description, arguments: p.arguments }));
          upstreamResponse = new Response(
            JSON.stringify({ jsonrpc: "2.0", id: jsonBody.id ?? null, result: { prompts } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        } else if (jsonBody.method === "prompts/get" && jsonBody.params?.name) {
          try {
            const content = await clientManager.getPrompt(
              jsonBody.params.name,
              serverId,
              jsonBody.params?.arguments || {},
            );
            upstreamResponse = new Response(
              JSON.stringify({ jsonrpc: "2.0", id: jsonBody.id ?? null, result: content }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          } catch (e) {
            upstreamResponse = new Response(
              JSON.stringify({ jsonrpc: "2.0", id: jsonBody.id ?? null, error: { code: -32000, message: (e as Error).message } }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
        } else if (jsonBody.method === "roots/list") {
          // Return empty roots; we are not exposing filesystem via proxy
          upstreamResponse = new Response(
            JSON.stringify({ jsonrpc: "2.0", id: jsonBody.id ?? null, result: { roots: [] } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        } else if (jsonBody.method === "logging/setLevel") {
          // Acknowledge without changing anything
          upstreamResponse = new Response(
            JSON.stringify({ jsonrpc: "2.0", id: jsonBody.id ?? null, result: { success: true } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        } else if (jsonBody.method?.startsWith("notifications/")) {
          // Acknowledge notifications without error to avoid client failures
          upstreamResponse = new Response("", { status: 200 });
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
