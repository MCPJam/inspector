/**
 * MCPJam Public API — v1 live-MCP surface (Inspector Node).
 *
 * Mounted at `/api/v1`. Resource-oriented, project-scoped routes that wrap the
 * same core helpers as `/api/web/*` (no forked handler logic) and emit the
 * canonical v1 envelope. Covers read diagnostics (validate/doctor/lists) and
 * write operations: tools/call, prompts/get, resources/read, OAuth token
 * import, and async eval runs (POST creates + detaches; agents poll the GET
 * routes for status, iteration results, and traces).
 */
import { Hono } from "hono";
import { bearerAuthMiddleware } from "../../middleware/bearer-auth.js";
import { guestRateLimitMiddleware } from "../../middleware/guest-rate-limit.js";
import servers from "./servers.js";
import tools from "./tools.js";
import prompts from "./prompts.js";
import resources from "./resources.js";
import exporter from "./export.js";
import evals from "./evals.js";
import oauth from "./oauth.js";
import { v1Error, v1OnError } from "./envelope.js";

const v1 = new Hono();

// Every v1 live-op route requires bearer auth + guest rate limiting, matching
// the /api/web/* MCP operation routes.
v1.use("*", bearerAuthMiddleware, guestRateLimitMiddleware);

// Symmetric with the Convex /v1/* surface (publicApi/routes.ts: authedV1
// rejects identity.issuer === GUEST_ISSUER): the public API is a developer
// surface, not a guest surface. bearerAuthMiddleware admits guest tokens (sets
// c.set("guestId")) so the deep Convex authorize-batch round-trip would
// eventually 403, but that's a different error path and depends on a layer
// far below the perimeter. Reject guests at the v1 boundary so the contract
// is the same on both halves and a regression in the deeper layer can't
// silently expose live-MCP ops.
v1.use("*", async (c, next) => {
  if (c.get("guestId")) {
    return v1Error(c, "UNAUTHORIZED", "Guests cannot access /api/v1");
  }
  return next();
});

// Each sub-router declares full resource paths; mount them all at the root.
v1.route("/", servers);
v1.route("/", tools);
v1.route("/", prompts);
v1.route("/", resources);
v1.route("/", exporter);
v1.route("/", evals);
v1.route("/", oauth);

v1.onError((error, c) => v1OnError(error, c));

export default v1;
