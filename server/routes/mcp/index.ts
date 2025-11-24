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
import openai from "./openai";
import registry from "./registry";
import models from "./models";
import listTools from "./list-tools";
import tokenizer from "./tokenizer";
import tunnelsRoute from "./tunnels";

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

// OpenAI Apps SDK widget endpoints
mcp.route("/openai", openai);

// Prompts endpoints - REAL IMPLEMENTATION
mcp.route("/prompts", prompts);

// OAuth proxy endpoints
mcp.route("/oauth", oauth);

// Export endpoints - REAL IMPLEMENTATION
mcp.route("/export", exporter);

// Unified HTTP bridges (SSE + POST) for connected servers
mcp.route("/adapter-http", adapterHttp);
mcp.route("/manager-http", managerHttp);

// Registry endpoints - MCP server registry integration
mcp.route("/registry", registry);

// Models endpoints - fetch model metadata from Convex backend
mcp.route("/models", models);

// Tokenizer endpoints - count tokens for MCP tools
mcp.route("/tokenizer", tokenizer);

// Tunnel management endpoints - create ngrok tunnels for servers
mcp.route("/tunnels", tunnelsRoute);

export default mcp;
