import { Hono } from "hono";
import "../../types/hono";

const managerHttp = new Hono();

// In-memory SSE session store per serverId:sessionId
type Session = {
  send: (event: string, data: string) => void;
  close: () => void;
};
const sessions: Map<string, Session> = new Map();
const latestSessionByServer: Map<string, string> = new Map();

// Minimal HTTP adapter that exposes a JSON-RPC interface for a connected MCP server
// at /api/mcp/manager-http/:serverId. This lets our Interceptor do a pure HTTP proxy
// like the reference implementation while we bridge to MCPJamClientManager here.

managerHttp.options("/:serverId", (c) =>
  c.body(null, 204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,HEAD,OPTIONS",
    "Access-Control-Allow-Headers": "*, Authorization, Content-Type, Accept, Accept-Language",
    "Access-Control-Expose-Headers": "*",
    "Access-Control-Max-Age": "86400",
  }),
);

// Wildcard variants to tolerate trailing paths (e.g., /mcp)
managerHttp.options("/:serverId/*", (c) =>
  c.body(null, 204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,HEAD,OPTIONS",
    "Access-Control-Allow-Headers": "*, Authorization, Content-Type, Accept, Accept-Language",
    "Access-Control-Expose-Headers": "*",
    "Access-Control-Max-Age": "86400",
  }),
);

async function handleManagerHttp(c: any) {
  const serverId = c.req.param("serverId");
  const method = c.req.method;

  // SSE endpoint for clients that probe/subscribe via GET; HEAD advertises event-stream
  if (method === "HEAD") {
    return c.body(null, 200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "X-Accel-Buffering": "no",
    });
  }
  if (method === "GET") {
    const serverId = c.req.param("serverId");
    const encoder = new TextEncoder();
    const incomingUrl = new URL(c.req.url);
    // Allow proxy to override the endpoint base so the client posts back through the proxy
    const overrideBase = c.req.header("x-mcpjam-endpoint-base");
    let endpointBase: string;
    if (overrideBase && overrideBase.trim() !== "") {
      endpointBase = overrideBase.trim();
    } else {
      // Compute an absolute endpoint based on forwarded headers when present
      // so direct ngrok/edge access (without the proxy) advertises a reachable URL.
      const xfProto = c.req.header("x-forwarded-proto");
      const xfHost = c.req.header("x-forwarded-host");
      const host = xfHost || c.req.header("host");
      let proto = xfProto;
      if (!proto) {
        const originHeader = c.req.header("origin");
        if (originHeader && /^https:/i.test(originHeader)) proto = "https";
      }
      if (!proto) proto = "http";
      const origin = host ? `${proto}://${host}` : incomingUrl.origin;
      endpointBase = `${origin}/api/mcp/manager-http/${serverId}/messages`;
    }
    const sessionId = crypto.randomUUID();
    let timer: any;
    const stream = new ReadableStream({
      start(controller) {
        console.log("[manager-http] SSE open", { serverId, sessionId });
        const send = (event: string, data: string) => {
          controller.enqueue(encoder.encode(`event: ${event}\n`));
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        };
        const close = () => {
          try { controller.close(); } catch {}
        };

        // Register session
        sessions.set(`${serverId}:${sessionId}`, { send, close });
        latestSessionByServer.set(serverId, sessionId);
        console.log("[manager-http] session registered", { key: `${serverId}:${sessionId}` });

        // Ping and endpoint per SSE transport handshake
        send("ping", "");
        const sep = endpointBase.includes("?") ? "&" : "?";
        const url = `${endpointBase}${sep}sessionId=${sessionId}`;
        console.log("[manager-http] endpoint", { serverId, sessionId, url });
        // Emit endpoint as a plain string URL for broad client compatibility.
        send("endpoint", url);

        // Periodic keepalive comments so proxies don’t buffer/close
        timer = setInterval(() => {
          try { controller.enqueue(encoder.encode(`: keepalive ${Date.now()}\n\n`)); } catch {}
        }, 15000);
      },
      cancel() {
        try { clearInterval(timer); } catch {}
        console.log("[manager-http] SSE close", { serverId, sessionId });
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
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "*",
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

  const id = body?.id ?? null;
  const m = body?.method as string | undefined;
  const params = body?.params ?? {};

  const respond = (payload: any, status = 200) =>
    c.body(JSON.stringify(payload), status, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "*",
    });

  const clientManager = c.mcpJamClientManager;

  try {
    // Notifications: no response body
    if (!m) {
      return c.body(null, 204, { "Access-Control-Allow-Origin": "*" });
    }

    switch (m) {
      case "initialize": {
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
        return respond({ jsonrpc: "2.0", id, result });
      }
      case "tools/list": {
        const toolsets = await clientManager.getToolsetsForServer(serverId);
        const tools = Object.keys(toolsets).map((name) => ({
          name,
          description: (toolsets as any)[name].description,
          inputSchema: (toolsets as any)[name].inputSchema,
          outputSchema: (toolsets as any)[name].outputSchema,
        }));
        return respond({ jsonrpc: "2.0", id, result: { tools } });
      }
      case "tools/call": {
        try {
          const exec = await clientManager.executeToolDirect(
            `${serverId}:${params?.name}`,
            params?.arguments || {},
          );
          // Format response according to MCP CallToolResult spec
          const result = {
            content: [
              {
                type: "text",
                text: typeof exec.result === 'string' ? exec.result : JSON.stringify(exec.result, null, 2)
              }
            ],
            isError: false
          };
          return respond({ jsonrpc: "2.0", id, result });
        } catch (e: any) {
          // Return error as a successful CallToolResult with isError: true
          const result = {
            content: [
              {
                type: "text",
                text: `Error: ${e?.message || String(e)}`
              }
            ],
            isError: true
          };
          return respond({ jsonrpc: "2.0", id, result });
        }
      }
      case "resources/list": {
        const resources = clientManager.getResourcesForServer(serverId).map((r) => ({
          uri: r.uri,
          name: r.name,
          description: r.description,
          mimeType: r.mimeType,
        }));
        return respond({ jsonrpc: "2.0", id, result: { resources } });
      }
      case "resources/read": {
        try {
          const content = await clientManager.getResource(params?.uri, serverId);
          // Format response according to MCP ReadResourceResult spec
          const result = {
            contents: [
              {
                uri: params?.uri,
                mimeType: content?.mimeType || "text/plain",
                text: typeof content === 'string' ? content : JSON.stringify(content, null, 2)
              }
            ]
          };
          return respond({ jsonrpc: "2.0", id, result });
        } catch (e: any) {
          return respond({
            jsonrpc: "2.0",
            id,
            error: { code: -32000, message: e?.message || String(e) },
          });
        }
      }
      case "prompts/list": {
        const prompts = clientManager
          .getPromptsForServer(serverId)
          .map((p) => ({ name: p.name, description: p.description, arguments: p.arguments }));
        return respond({ jsonrpc: "2.0", id, result: { prompts } });
      }
      case "prompts/get": {
        try {
          const content = await clientManager.getPrompt(
            params?.name,
            serverId,
            params?.arguments || {},
          );
          // Format response according to MCP GetPromptResult spec
          const result = {
            description: content?.description || `Prompt: ${params?.name}`,
            messages: [
              {
                role: "user",
                content: {
                  type: "text",
                  text: typeof content === 'string' ? content : JSON.stringify(content, null, 2)
                }
              }
            ]
          };
          return respond({ jsonrpc: "2.0", id, result });
        } catch (e: any) {
          return respond({
            jsonrpc: "2.0",
            id,
            error: { code: -32000, message: e?.message || String(e) },
          });
        }
      }
      case "roots/list": {
        return respond({ jsonrpc: "2.0", id, result: { roots: [] } });
      }
      case "logging/setLevel": {
        return respond({ jsonrpc: "2.0", id, result: { success: true } });
      }
      case "notifications/initialized": {
        // Client sends this after receiving initialize response
        console.log("[manager-http] Client initialized", { serverId });
        return c.body(null, 204, { "Access-Control-Allow-Origin": "*" });
      }
      case "ping": {
        // Handle ping requests
        return respond({ jsonrpc: "2.0", id, result: {} });
      }
      default: {
        // Other notifications
        if (m.startsWith("notifications/")) {
          console.log("[manager-http] Notification received", { method: m, serverId });
          return c.body(null, 204, { "Access-Control-Allow-Origin": "*" });
        }
        return respond({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not implemented: ${m}` },
        });
      }
    }
  } catch (e: any) {
    return respond({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: e?.message || String(e) },
    });
  }
}

managerHttp.all("/:serverId", handleManagerHttp);
managerHttp.all("/:serverId/*", handleManagerHttp);

// Endpoint to receive client messages for SSE transport: /:serverId/messages?sessionId=...
managerHttp.post("/:serverId/messages", async (c) => {
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
  console.log("[manager-http] POST messages", { key, resolved: !!sess });
  if (!sess) {
    return c.json({ error: "Invalid session" }, 400);
  }
  let body: any;
  try { body = await c.req.json(); } catch { body = undefined; }
  const id = body?.id ?? null;
  const method = body?.method as string | undefined;
  const params = body?.params ?? {};

  // Reuse the JSON-RPC handling from above by constructing a faux request
  const mkResponse = async () => {
    if (!method) return null;
    switch (method) {
      case "initialize": {
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
        return { jsonrpc: "2.0", id, result };
      }
      case "tools/list": {
        const toolsets = await c.mcpJamClientManager.getToolsetsForServer(serverId);
        const tools = Object.keys(toolsets).map((name) => ({
          name,
          description: (toolsets as any)[name].description,
          inputSchema: (toolsets as any)[name].inputSchema,
          outputSchema: (toolsets as any)[name].outputSchema,
        }));
        return { jsonrpc: "2.0", id, result: { tools } };
      }
      case "tools/call": {
        try {
          const exec = await c.mcpJamClientManager.executeToolDirect(`${serverId}:${params?.name}`, params?.arguments || {});
          // Format response according to MCP CallToolResult spec
          const result = {
            content: [
              {
                type: "text",
                text: typeof exec.result === 'string' ? exec.result : JSON.stringify(exec.result, null, 2)
              }
            ],
            isError: false
          };
          return { jsonrpc: "2.0", id, result };
        } catch (e: any) {
          // Return error as a successful CallToolResult with isError: true
          const result = {
            content: [
              {
                type: "text",
                text: `Error: ${e?.message || String(e)}`
              }
            ],
            isError: true
          };
          return { jsonrpc: "2.0", id, result };
        }
      }
      case "resources/list": {
        const resources = c.mcpJamClientManager.getResourcesForServer(serverId).map((r) => ({ uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType }));
        return { jsonrpc: "2.0", id, result: { resources } };
      }
      case "resources/read": {
        try {
          const content = await c.mcpJamClientManager.getResource(params?.uri, serverId);
          // Format response according to MCP ReadResourceResult spec
          const result = {
            contents: [
              {
                uri: params?.uri,
                mimeType: content?.mimeType || "text/plain",
                text: typeof content === 'string' ? content : JSON.stringify(content, null, 2)
              }
            ]
          };
          return { jsonrpc: "2.0", id, result };
        } catch (e: any) {
          return { jsonrpc: "2.0", id, error: { code: -32000, message: e?.message || String(e) } };
        }
      }
      case "prompts/list": {
        const prompts = c.mcpJamClientManager.getPromptsForServer(serverId).map((p) => ({ name: p.name, description: p.description, arguments: p.arguments }));
        return { jsonrpc: "2.0", id, result: { prompts } };
      }
      case "prompts/get": {
        try {
          const content = await c.mcpJamClientManager.getPrompt(params?.name, serverId, params?.arguments || {});
          // Format response according to MCP GetPromptResult spec
          const result = {
            description: content?.description || `Prompt: ${params?.name}`,
            messages: [
              {
                role: "user",
                content: {
                  type: "text",
                  text: typeof content === 'string' ? content : JSON.stringify(content, null, 2)
                }
              }
            ]
          };
          return { jsonrpc: "2.0", id, result };
        } catch (e: any) {
          return { jsonrpc: "2.0", id, error: { code: -32000, message: e?.message || String(e) } };
        }
      }
      case "roots/list": {
        return { jsonrpc: "2.0", id, result: { roots: [] } };
      }
      case "logging/setLevel": {
        return { jsonrpc: "2.0", id, result: { success: true } };
      }
      case "notifications/initialized": {
        // Client sends this after receiving initialize response
        console.log("[manager-http] Client initialized via messages", { serverId });
        return null; // no response for notifications
      }
      case "ping": {
        // Handle ping requests
        return { jsonrpc: "2.0", id, result: {} };
      }
      default: {
        if (method.startsWith("notifications/")) {
          console.log("[manager-http] Notification received via messages", { method, serverId });
          return null; // no response
        }
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not implemented: ${method}` } };
      }
    }
  };

  try {
    const responseMessage = await mkResponse();
    // If there is a JSON-RPC response, emit it over SSE to the client
    if (responseMessage) {
      try {
        console.log("[manager-http] emit message", { key, id: responseMessage.id, method });
        sess.send("message", JSON.stringify(responseMessage));
      } catch {}
    }
    // 202 Accepted per SSE transport semantics
    return c.body("Accepted", 202, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "*",
    });
  } catch (e: any) {
    return c.body("Error", 400, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "*",
    });
  }
});

export default managerHttp;
