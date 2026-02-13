import { Hono } from "hono";
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
import models from "./models";
import listTools from "./list-tools";
import tokenizer from "./tokenizer";
import tunnelsRoute from "./tunnels";
import logLevel from "./log-level";
import tasks from "./tasks";
import skills from "./skills";
import xrayPayload from "./xray-payload";

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

// Skills endpoints - Agent skills from .mcpjam/skills/
mcp.route("/skills", skills);

// X-Ray payload endpoint - returns actual payload sent to model
mcp.route("/xray-payload", xrayPayload);

export default mcp;
