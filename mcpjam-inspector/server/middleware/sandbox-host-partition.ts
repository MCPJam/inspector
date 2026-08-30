/**
 * Sandbox-host partition
 *
 * The MCP Apps widget sandbox is a second DNS name on THIS service, not a
 * separate deploy. HOSTED_DEPLOYMENT.md has always said the sandbox host "only
 * needs to answer" the sandbox-proxy route; nothing enforced the other half of
 * that sentence, so the origin whose entire job is holding untrusted widget
 * content also served the app shell, its bundle, and /api.
 *
 * That also broke the only alarm for a genuinely same-origin sandbox. A
 * crawler walking our DNS names loaded the Inspector ON sandbox.mcpjam.com,
 * where `SANDBOX_ORIGIN === window.location.origin` holds by definition, and
 * the client boot guard reported it as a misconfigured deploy
 * (INSPECTOR-CLIENT-247). No client can tell those two deploys apart — the
 * page does not know which hostname it was supposed to be served as. Only the
 * process does, which is why the invariant lives here and not in the browser.
 *
 * Registered in server/index.ts's security stack, NOT in the production static
 * block: the API routers mount before that block, so a partition there would
 * leave /api reachable on the sandbox host.
 */

import type { Context, Hono, MiddlewareHandler } from "hono";
import {
  MCPJAM_HOSTED_ORIGIN,
  resolveSandboxIsolation,
  SANDBOX_HOSTS,
  type SandboxIsolationStatus,
} from "../config.js";
import { logger as appLogger } from "../utils/logger.js";

/**
 * Everything a sandbox hostname is allowed to answer.
 *
 * EXACT matches only — same rule as HOSTED_OPEN_MCP_PATHS, and for the same
 * reason: a sub-path or trailing-slash variant is still a path this host has
 * no business serving.
 *
 *   /api/web/apps/mcp-apps/sandbox-proxy — the sandbox document itself. It is
 *       self-contained (no external `src` or `href`) and receives widget HTML
 *       over postMessage, so one path is genuinely all the origin needs.
 *   /health — so the hostname stays probeable. It reports `sandboxIsolation`,
 *       which is how a canary confirms this partition is the reason the rest
 *       of the origin 404s rather than the deploy being broken.
 */
export const SANDBOX_HOST_OPEN_PATHS = new Set<string>([
  "/api/web/apps/mcp-apps/sandbox-proxy",
  "/health",
]);

/**
 * Host header without its port, lowercased.
 *
 * The same read the caniuse/score vanity-domain gates in server/index.ts use,
 * which is the evidence that `Host` — not `X-Forwarded-Host` — carries the
 * public hostname through the platform's proxy in production.
 *
 * A client can of course send whatever `Host` it likes, and spoofing one is
 * self-defeating in both directions: claiming a sandbox host only 404s
 * yourself, and claiming the app host from the sandbox address returns a page
 * you could already fetch from the app address. The control here is browser
 * origin semantics, and a browser cannot forge the header.
 */
function requestHost(c: Context): string {
  return (c.req.header("Host") ?? "").toLowerCase().split(":")[0];
}

const sandboxHostPartition: MiddlewareHandler = async (c, next) => {
  if (!SANDBOX_HOSTS.has(requestHost(c))) {
    await next();
    return;
  }
  if (SANDBOX_HOST_OPEN_PATHS.has(c.req.path)) {
    await next();
    return;
  }
  // Plain 404, not a 4xx that names the partition: a hostname that exists to
  // hold untrusted content should describe this service as little as it can.
  return c.text("Not Found", 404);
};

/**
 * Register the sandbox-host partition on `app`. Host-gated, so it is inert on
 * every other DNS name the service answers; with SANDBOX_HOSTS empty it is
 * inert everywhere. Call after the security-headers and origin-validation
 * middlewares, before the API routers mount.
 */
export function applySandboxHostPartition(app: Hono): void {
  app.use("*", sandboxHostPartition);
}

/** The operator-facing complaint for a broken status; null when there is none. */
function sandboxIsolationFault(status: SandboxIsolationStatus): string | null {
  switch (status) {
    case "ok":
      return null;
    case "unset":
      return "SANDBOX_HOSTS names no hostname to partition (or MCPJAM_HOSTED_ORIGIN is unparseable), so MCP Apps widgets are not isolated from the host app.";
    case "same-origin":
      return `SANDBOX_HOSTS contains the app's own host from MCPJAM_HOSTED_ORIGIN (${MCPJAM_HOSTED_ORIGIN}): MCP Apps widgets share cookies and storage with the host app, and that hostname now answers nothing but the sandbox proxy.`;
  }
}

/**
 * Report a deploy that cannot isolate widget content, once, at boot.
 *
 * Deliberately non-fatal, the same stance the client boot guard takes: refusing
 * to start would take the whole app down over a widget-isolation setting, which
 * is a worse outcome than a loud deploy. `/health` carries the same verdict as
 * `sandboxIsolation` for anything that would rather poll than read logs.
 */
export function assertSandboxIsolation(): void {
  const fault = sandboxIsolationFault(resolveSandboxIsolation());
  if (fault) {
    appLogger.error(`[Security] ${fault}`);
  }
}
