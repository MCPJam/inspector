import { Hono } from "hono";
import connect from "./connect";
import servers from "./servers";
import tools from "./tools";
import resources from "./resources";
import prompts from "./prompts";
import chat from "./chat";
import tests from "./tests.ts";
import oauth from "./oauth";

const mcp = new Hono();

// Health check
mcp.get("/health", (c) => {
  return c.json({
    service: "MCP API",
    status: "ready",
    timestamp: new Date().toISOString(),
  });
});

// Chat endpoint - REAL IMPLEMENTATION
mcp.route("/chat", chat);

// Connect endpoint - REAL IMPLEMENTATION
mcp.route("/connect", connect);

// Servers management endpoints - REAL IMPLEMENTATION
mcp.route("/servers", servers);

// Tools endpoint - REAL IMPLEMENTATION
mcp.route("/tools", tools);

// Tests endpoint - generate per-test agents
mcp.route("/tests", tests);

// Resources endpoints - REAL IMPLEMENTATION
mcp.route("/resources", resources);

// Prompts endpoints - REAL IMPLEMENTATION
mcp.route("/prompts", prompts);

// OAuth proxy endpoints
mcp.route("/oauth", oauth);

export default mcp;
