import { Hono } from "hono";
import "../../types/hono";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// In-memory SSE session registry per serverId
type Session = {
  send: (event: string, data: string) => void;
  close: () => void;
};
const sessions: Map<string, Session> = new Map();
const latestSessionByServer: Map<string, string> = new Map();

// Minimal in-process HTTP adapter that bridges a connected STDIO server
// to a simple HTTP JSON-RPC endpoint: POST /api/mcp/adapter-http/:serverId
// This is stateless: no SSE, all responses are 200 JSON (requests with id) or 202 for notifications.

const adapterHttp = new Hono();

// CORS preflight
adapterHttp.options("/:serverId", (c) =>
  c.body(null, 204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, Accept, Accept-Language",
    "Access-Control-Expose-Headers": "*",
    "Access-Control-Max-Age": "86400",
  }),
);

// Explicitly disable GET/HEAD to mirror stateless POST-only servers
adapterHttp.get("/:serverId", (c) => {
  // Provide an optional SSE transport for clients that expect Streamable HTTP
  const serverId = c.req.param("serverId");
  const encoder = new TextEncoder();
  const sessionId = crypto.randomUUID();
  let timer: any;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: string) => {
        controller.enqueue(encoder.encode(`event: ${event}\n`));
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      };
      const close = () => {
        try { controller.close(); } catch {}
      };
      sessions.set(`${serverId}:${sessionId}`, { send, close });
      latestSessionByServer.set(serverId, sessionId);
      // Minimal handshake
      send("ping", "");
      const base = new URL(c.req.url);
      base.pathname = `/api/mcp/adapter-http/${serverId}/messages`;
      base.search = `sessionId=${sessionId}`;
      send("endpoint", base.toString());
      timer = setInterval(() => {
        try { controller.enqueue(encoder.encode(`: keepalive ${Date.now()}\n\n`)); } catch {}
      }, 15000);
    },
    cancel() {
      try { clearInterval(timer); } catch {}
      sessions.delete(`${serverId}:${sessionId}`);
      if (latestSessionByServer.get(serverId) === sessionId) latestSessionByServer.delete(serverId);
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
});

adapterHttp.on("HEAD", "/:serverId", (c) =>
  c.text("GET requests are disabled", 405, {
    "Access-Control-Allow-Origin": "*",
    Allow: "POST, OPTIONS",
  }),
);

adapterHttp.post("/:serverId", async (c) => {
  const serverId = c.req.param("serverId");

  // Parse JSON body (best effort)
  let body: any = undefined;
  try {
    body = await c.req.json();
  } catch {
    // tolerate text
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

  const respond = (payload: any, status = 200) =>
    c.body(JSON.stringify(payload), status, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "*",
    });

  const clientManager = c.mcpJamClientManager;

  // Notifications (no id or explicit notifications/*) → 202 Accepted
  if (!method || method.startsWith("notifications/")) {
    return c.body("Accepted", 202, { "Access-Control-Allow-Origin": "*" });
  }

  try {
    switch (method) {
      case "initialize": {
        // Spec-aligned capabilities shape
        const result = {
          protocolVersion: "2025-06-18",
          capabilities: {
            tools: { listChanged: true },
            prompts: {},
            resources: { listChanged: true, subscribe: true },
            logging: {},
            roots: { listChanged: true },
          },
          serverInfo: { name: serverId, version: "stdio-adapter" },
        };
        return respond({ jsonrpc: "2.0", id, result });
      }
      case "tools/list": {
        const toolsets = await clientManager.getToolsetsForServer(serverId);
        const tools = Object.keys(toolsets).map((name) => ({
          name,
          description: (toolsets as any)[name].description,
          inputSchema: toJsonSchemaMaybe((toolsets as any)[name].inputSchema),
          outputSchema: toJsonSchemaMaybe((toolsets as any)[name].outputSchema),
        }));
        return respond({ jsonrpc: "2.0", id, result: { tools } });
      }
      case "tools/call": {
        try {
          const exec = await clientManager.executeToolDirect(
            `${serverId}:${params?.name}`,
            params?.arguments || {},
          );
          return respond({ jsonrpc: "2.0", id, result: exec.result });
        } catch (e: any) {
          return respond({
            jsonrpc: "2.0",
            id,
            error: { code: -32000, message: e?.message || String(e) },
          });
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
          return respond({ jsonrpc: "2.0", id, result: content });
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
          return respond({ jsonrpc: "2.0", id, result: content });
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
      default: {
        return respond({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not implemented: ${method}` },
        });
      }
    }
  } catch (e: any) {
    return respond({ jsonrpc: "2.0", id, error: { code: -32000, message: e?.message || String(e) } });
  }
});

export default adapterHttp;

// Messages endpoint for the optional SSE transport
adapterHttp.post("/:serverId/messages", async (c) => {
  const serverId = c.req.param("serverId");
  const url = new URL(c.req.url);
  const sessionId = url.searchParams.get("sessionId") || "";
  const key = `${serverId}:${sessionId}`;
  let sess = sessions.get(key);
  if (!sess) {
    const fallback = latestSessionByServer.get(serverId);
    if (fallback) sess = sessions.get(`${serverId}:${fallback}`);
  }
  if (!sess) {
    return c.json({ error: "Invalid session" }, 400);
  }
  let body: any;
  try { body = await c.req.json(); } catch { try { const txt = await c.req.text(); body = txt ? JSON.parse(txt) : undefined; } catch { body = undefined; } }

  const id = body?.id ?? null;
  const method = body?.method as string | undefined;
  const params = body?.params ?? {};

  const respondMessage = (msg: any) => {
    try { sess!.send("message", JSON.stringify(msg)); } catch {}
  };

  const clientManager = c.mcpJamClientManager;

  const mkResponse = async () => {
    if (!method) return null;
    switch (method) {
      case "initialize": {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: {
              tools: { listChanged: true },
              prompts: {},
              resources: { listChanged: true, subscribe: true },
              logging: {},
              roots: { listChanged: true },
            },
            serverInfo: { name: serverId, version: "stdio-adapter" },
          },
        };
      }
      case "tools/list": {
        const toolsets = await clientManager.getToolsetsForServer(serverId);
        const tools = Object.keys(toolsets).map((name) => ({
          name,
          description: (toolsets as any)[name].description,
          inputSchema: toJsonSchemaMaybe((toolsets as any)[name].inputSchema),
          outputSchema: toJsonSchemaMaybe((toolsets as any)[name].outputSchema),
        }));
        return { jsonrpc: "2.0", id, result: { tools } };
      }
      case "tools/call": {
        try {
          const exec = await clientManager.executeToolDirect(`${serverId}:${params?.name}`, params?.arguments || {});
          return { jsonrpc: "2.0", id, result: exec.result };
        } catch (e: any) {
          return { jsonrpc: "2.0", id, error: { code: -32000, message: e?.message || String(e) } };
        }
      }
      case "resources/list": {
        const resources = clientManager.getResourcesForServer(serverId).map((r) => ({ uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType }));
        return { jsonrpc: "2.0", id, result: { resources } };
      }
      case "resources/read": {
        try {
          const content = await clientManager.getResource(params?.uri, serverId);
          return { jsonrpc: "2.0", id, result: content };
        } catch (e: any) {
          return { jsonrpc: "2.0", id, error: { code: -32000, message: e?.message || String(e) } };
        }
      }
      case "prompts/list": {
        const prompts = clientManager.getPromptsForServer(serverId).map((p) => ({ name: p.name, description: p.description, arguments: p.arguments }));
        return { jsonrpc: "2.0", id, result: { prompts } };
      }
      case "prompts/get": {
        try {
          const content = await clientManager.getPrompt(params?.name, serverId, params?.arguments || {});
          return { jsonrpc: "2.0", id, result: content };
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
      default: {
        if (method.startsWith("notifications/")) return null;
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not implemented: ${method}` } };
      }
    }
  };

  const responseMessage = await mkResponse();
  if (responseMessage) respondMessage(responseMessage);
  return c.body("Accepted", 202, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "*",
  });
});
function toJsonSchemaMaybe(schema: any): any {
  try {
    if (schema && typeof schema === "object") {
      // Detect Zod schema heuristically
      if (schema instanceof z.ZodType || ("_def" in schema && "parse" in schema)) {
        return zodToJsonSchema(schema as z.ZodType<any>);
      }
    }
  } catch {}
  return schema;
}
