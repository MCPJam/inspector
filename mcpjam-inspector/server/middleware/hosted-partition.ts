/**
 * Hosted-mode API partition
 *
 * In hosted mode the legacy local-machine API families (/api/mcp/*,
 * /api/apps/*, /api/session-token) are disabled — the hosted product can't
 * spawn local servers or hand out a localhost session token. A small allowlist
 * of read-only, keyless paths stays open in both modes.
 *
 * Both production entrypoints (server/app.ts::createHonoApp for Electron and
 * server/index.ts for the hosted/Node server) must apply this identically.
 * This module is the single source of truth so the two can never drift.
 */

import type { Context, Hono, MiddlewareHandler } from "hono";
import models from "../routes/mcp/models.js";

/**
 * /api/mcp paths that remain reachable in hosted mode.
 *
 * EXACT matches only — a sub-path or trailing-slash variant is intentionally
 * 410'd (both catalog clients fetch the exact path, see
 * client/src/hooks/use-hosted-model-catalog.ts and use-model-metadata.ts).
 *
 *   /api/mcp/health  — liveness probe, no data.
 *   /api/mcp/models  — public keyless catalog proxy that powers the model
 *                      picker for everyone incl. guests. Forwards no auth and
 *                      returns only the backend's keyless /v1/models catalog.
 *                      See routes/mcp/models.ts.
 */
export const HOSTED_OPEN_MCP_PATHS = new Set<string>([
  "/api/mcp/health",
  "/api/mcp/models",
]);

/** /api/apps paths that remain reachable in hosted mode (health only). */
const HOSTED_OPEN_APPS_PATHS = new Set<string>(["/api/apps/health"]);

const strictModeResponse = (c: Context, path: string) =>
  c.json(
    {
      code: "FEATURE_NOT_SUPPORTED",
      message: `${path} is disabled in hosted mode`,
    },
    410
  );

const gate =
  (openPaths: Set<string>, label: string): MiddlewareHandler =>
  async (c, next) => {
    if (openPaths.has(c.req.path)) {
      await next();
      return;
    }
    return strictModeResponse(c, label);
  };

/**
 * Register the hosted-mode partition middlewares on `app`. Call only when
 * HOSTED_MODE is true, after the security headers + origin-validation
 * middlewares and before session auth (matching the local-mode ordering).
 */
export function applyHostedPartition(app: Hono): void {
  const sessionToken: MiddlewareHandler = async (c) =>
    strictModeResponse(c, "/api/session-token");
  app.use("/api/session-token", sessionToken);
  app.use("/api/mcp", gate(HOSTED_OPEN_MCP_PATHS, "/api/mcp/*"));
  app.use("/api/mcp/*", gate(HOSTED_OPEN_MCP_PATHS, "/api/mcp/*"));
  app.use("/api/apps", gate(HOSTED_OPEN_APPS_PATHS, "/api/apps/*"));
  app.use("/api/apps/*", gate(HOSTED_OPEN_APPS_PATHS, "/api/apps/*"));
}

/**
 * Mount the handlers for the hosted-open paths — the hosted-mode counterpart to
 * mounting the full /api/mcp and /api/apps routers in local mode. Keep in sync
 * with HOSTED_OPEN_MCP_PATHS / HOSTED_OPEN_APPS_PATHS above.
 *
 * `models` registers `GET "/"`, so mounting it at "/api/mcp/models" serves
 * `GET /api/mcp/models`.
 */
export function mountHostedOpenRoutes(app: Hono): void {
  app.get("/api/mcp/health", (c) =>
    c.json({
      service: "MCP API",
      status: "ready",
      timestamp: new Date().toISOString(),
    })
  );
  app.get("/api/apps/health", (c) =>
    c.json({
      service: "Apps API",
      status: "ready",
      timestamp: new Date().toISOString(),
    })
  );
  app.route("/api/mcp/models", models);
}
