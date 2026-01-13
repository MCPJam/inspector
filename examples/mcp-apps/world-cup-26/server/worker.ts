/**
 * Cloudflare Workers entry point for World Cup 2026 MCP Server
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { createMcpServer } from "./mcp-worker";
import type { Env } from "../worker-configuration";

const app = new Hono<{ Bindings: Env }>();

// CORS middleware
app.use("*", cors());

// MCP Protocol endpoint
app.all("/mcp", async (c) => {
  const server = createMcpServer(c.env.ASSETS);
  
  // Handle JSON-RPC request
  const body = await c.req.json().catch(() => null);
  if (!body) {
    return c.json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    }, 400);
  }

  console.log(`[Worker] Received request:`, JSON.stringify(body, null, 2));
  const response = await server.handleRequest(body);
  console.log(`[Worker] Sending response:`, JSON.stringify(response, null, 2).substring(0, 500));
  return c.json(response);
});

// Health check
app.get("/", (c) => {
  return c.json({
    name: "worldcup-2026-mcp",
    version: "1.0.0",
    status: "ok",
  });
});

export default app;










