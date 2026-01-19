import { Hono } from "hono";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import connect from "./connect";
import servers from "./servers";
import tools from "./tools";
import resources from "./resources";
import resourceTemplates from "./resource-templates";
import prompts from "./prompts";
import chatV2 from "./chat-v2";
import oauth from "./oauth";
import exporter from "./export";
import evals from "./evals";
import { adapterHttp, managerHttp } from "./http-adapters";
import elicitation from "./elicitation";
import apps from "./apps";
import models from "./models";
import listTools from "./list-tools";
import tokenizer from "./tokenizer";
import tunnelsRoute from "./tunnels";
import logLevel from "./log-level";
import tasks from "./tasks";

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to sandbox proxy HTML
const sandboxProxyPath = path.join(__dirname, "sandbox-proxy.html");

const mcp = new Hono();

// Health check
mcp.get("/health", (c) => {
  return c.json({
    service: "MCP API",
    status: "ready",
    timestamp: new Date().toISOString(),
  });
});

// Chat v2 endpoint
mcp.route("/chat-v2", chatV2);

// Elicitation endpoints
mcp.route("/elicitation", elicitation);

// Connect endpoint - REAL IMPLEMENTATION
mcp.route("/connect", connect);

// Servers management endpoints - REAL IMPLEMENTATION
mcp.route("/servers", servers);

// Tools endpoint - REAL IMPLEMENTATION
mcp.route("/tools", tools);

// List tools endpoint - list all tools from selected servers
mcp.route("/list-tools", listTools);

// Evals endpoint - run evaluations
mcp.route("/evals", evals);

// Resources endpoints - REAL IMPLEMENTATION
mcp.route("/resources", resources);

// Resource Templates endpoints - REAL IMPLEMENTATION
mcp.route("/resource-templates", resourceTemplates);

// MCP Apps (SEP-1865) widget endpoints
mcp.route("/apps", apps);

// Sandbox proxy for MCP Apps double-iframe architecture (SEP-1865)
// Read file on each request in dev mode to support hot reload
mcp.get("/sandbox-proxy", (c) => {
  const sandboxProxyHtml = fs.readFileSync(sandboxProxyPath, "utf-8");
  c.header("Content-Type", "text/html; charset=utf-8");
  c.header("Cache-Control", "no-cache, no-store, must-revalidate");
  // Allow cross-origin framing between localhost and 127.0.0.1 for double-iframe architecture
  c.header(
    "Content-Security-Policy",
    "frame-ancestors 'self' http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*",
  );
  // Remove X-Frame-Options as it doesn't support multiple origins (CSP frame-ancestors takes precedence)
  c.res.headers.delete("X-Frame-Options");
  return c.body(sandboxProxyHtml);
});

// Prompts endpoints - REAL IMPLEMENTATION
mcp.route("/prompts", prompts);

// OAuth proxy endpoints
mcp.route("/oauth", oauth);

// Export endpoints - REAL IMPLEMENTATION
mcp.route("/export", exporter);

// Unified HTTP bridges (SSE + POST) for connected servers
mcp.route("/adapter-http", adapterHttp);
mcp.route("/manager-http", managerHttp);

// Models endpoints - fetch model metadata from Convex backend
mcp.route("/models", models);

// Tokenizer endpoints - count tokens for MCP tools
mcp.route("/tokenizer", tokenizer);

// Tunnel management endpoints - create ngrok tunnels for servers
mcp.route("/tunnels", tunnelsRoute);

// Logging level endpoint - configure per-server logging verbosity
mcp.route("/log-level", logLevel);

// Tasks endpoints - MCP Tasks experimental feature (spec 2025-11-25)
mcp.route("/tasks", tasks);

export default mcp;
