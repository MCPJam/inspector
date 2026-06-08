/**
 * MCPJam Public API — v1 live-MCP surface (Inspector Node).
 *
 * Mounted at `/api/v1`. Resource-oriented, project-scoped routes that wrap the
 * same core helpers as `/api/web/*` (no forked handler logic) and emit the
 * canonical v1 envelope. Read-only diagnostics ship first; mutating operations
 * (tools/execute, evals/run, generate-tests) are deferred to a follow-up that
 * adds the X-MCPJam-Approval flow.
 */
import { Hono } from "hono";
import { bearerAuthMiddleware } from "../../middleware/bearer-auth.js";
import { guestRateLimitMiddleware } from "../../middleware/guest-rate-limit.js";
import servers from "./servers.js";
import tools from "./tools.js";
import prompts from "./prompts.js";
import resources from "./resources.js";
import exporter from "./export.js";
import { v1OnError } from "./envelope.js";

const v1 = new Hono();

// Every v1 live-op route requires bearer auth + guest rate limiting, matching
// the /api/web/* MCP operation routes.
v1.use("*", bearerAuthMiddleware, guestRateLimitMiddleware);

// Each sub-router declares full resource paths; mount them all at the root.
v1.route("/", servers);
v1.route("/", tools);
v1.route("/", prompts);
v1.route("/", resources);
v1.route("/", exporter);

v1.onError((error, c) => v1OnError(error, c));

export default v1;
