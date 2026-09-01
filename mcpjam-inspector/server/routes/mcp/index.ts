import { Hono } from "hono";
import connect from "./connect";
import connectAdhoc from "./connect-adhoc";
import servers from "./servers";
import tools from "./tools";
import resources from "./resources";
import resourceTemplates from "./resource-templates";
import prompts from "./prompts";
import chatV2 from "./chat-v2";
import computers from "./computers";
import oauth from "./oauth";
import exporter from "./export";
import evals from "./evals";
import { adapterHttp, managerHttp } from "./http-adapters";
import elicitation from "./elicitation";
import mrtr from "./mrtr";
import models from "./models";
import listTools from "./list-tools";
import tokenizer from "./tokenizer";
import tunnelsRoute from "./tunnels";
import logLevel from "./log-level";
import tasks from "./tasks";
import skills from "./skills";
import serverSkills from "./server-skills";
import conformance from "./conformance";
import xaa from "./xaa";
import command from "./command";
import subscribe from "./subscribe";
import subscriptions from "./subscriptions";
import widgetRender from "./widget-render";
import widgetSession from "./widget-session";
import webmcpInspector from "./webmcp-inspector";
import audioTranscriptions from "./audio-transcriptions";
import plugins from "./plugins";
import { buildHealthMeta } from "../../utils/health-payload.js";

const mcp = new Hono();

// Health check
mcp.get("/health", (c) => {
  return c.json({
    service: "MCP API",
    status: "ready",
    timestamp: new Date().toISOString(),
    ...buildHealthMeta(),
  });
});

// Chat v2 endpoint
mcp.route("/chat-v2", chatV2);

// Local computer engine — consent capability (grant/verify/revoke)
mcp.route("/computers", computers);

// Speech-to-text endpoint
mcp.route("/audio", audioTranscriptions);

// Elicitation endpoints
mcp.route("/elicitation", elicitation);
// Modern multi-round-trip (`input_required` / MRTR) input bridge — MCP
// 2026-07-28 §12. Local surfaces collect the driver's per-round elicitation
// input over this SSE channel.
mcp.route("/mrtr", mrtr);

// Local plugin bundle cache (materialize / GC) — desktop runtime only
mcp.route("/plugins", plugins);

// Connect endpoint - REAL IMPLEMENTATION
mcp.route("/connect", connect);

// Ad-hoc connect: inline {serverId, serverConfig}, no project lookup. Backs the
// CLI harness-render flows (apps render/session) that target servers existing
// in no project. See connect-adhoc.ts.
mcp.route("/connect-adhoc", connectAdhoc);

// Inspector command bus endpoints
mcp.route("/command", command);
mcp.route("/subscribe", subscribe);

// Subscription bridge - observe the local manager's `subscriptions/listen`
// stream lifecycle (2026-07-28 §13.2) and state desired interests
mcp.route("/subscriptions", subscriptions);

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

// XAA synthetic issuer + debugger endpoints
mcp.route("/xaa", xaa);

// Export endpoints - REAL IMPLEMENTATION
mcp.route("/export", exporter);

// Unified HTTP bridges (SSE + POST) for connected servers
mcp.route("/adapter-http", adapterHttp);
mcp.route("/manager-http", managerHttp);

// Models endpoints - fetch model metadata from Convex backend
mcp.route("/models", models);

// Tokenizer endpoints - count tokens for MCP tools
mcp.route("/tokenizer", tokenizer);

// Tunnel management endpoints - create relay tunnels for servers
mcp.route("/tunnels", tunnelsRoute);

// Logging level endpoint - configure per-server logging verbosity
mcp.route("/log-level", logLevel);

// Tasks endpoints - MCP Tasks experimental feature (spec 2025-11-25)
mcp.route("/tasks", tasks);

// Skills endpoints - Agent skills from .mcpjam/skills/
mcp.route("/skills", skills);
// Skills served BY a connected MCP server (SEP-2640). A DISTINCT path from
// `/skills` above, which scans the local filesystem — same word, different
// thing, and the routes must not blur that.
mcp.route("/server-skills", serverSkills);

// Conformance endpoints - Protocol, Apps, OAuth checks
mcp.route("/conformance", conformance);

// Headless widget render - one-shot MCP App tool-result render (screenshot +
// verdict) via the eval browser harness. Local-mode only (mounted under
// /api/mcp/*); backs the CLI's `mcpjam apps render`.
mcp.route("/widget-render", widgetRender);

// Interactive headless widget sessions (keepMounted) - start/action/close with
// strict browser lifecycle. Local-mode only; backs `mcpjam apps session`.
mcp.route("/widget-session", widgetSession);
mcp.route("/webmcp", webmcpInspector);

export default mcp;
