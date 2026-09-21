/**
 * Sandbox proxy response headers, against the REAL router.
 *
 * This file previously re-declared a look-alike route inline, so it asserted
 * the shape of its own fixture and would have stayed green through any change
 * to what the app actually serves. It now mounts the real router behind the
 * real security middleware, which is the only arrangement that can catch the
 * two failures that matter: `frame-ancestors` drifting away from the origins
 * the proxy pins against, and the global `X-Frame-Options: SAMEORIGIN`
 * surviving to override it (the header does not support multiple origins, so
 * leaving it on would break the cross-origin sandbox everywhere at once).
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import mcpAppsRoutes from "../routes/apps/mcp-apps/index.js";
import { securityHeadersMiddleware } from "../middleware/security-headers.js";
import {
  SANDBOX_PROXY_LOCALHOST_PATTERNS,
  sandboxProxyHostOriginPatterns,
} from "../routes/apps/mcp-apps/sandbox-proxy-html.js";

const PROXY_PATH = "/api/apps/mcp-apps/sandbox-proxy";

function createApp(): Hono {
  const app = new Hono();
  app.use("*", securityHeadersMiddleware);
  app.route("/api/apps/mcp-apps", mcpAppsRoutes);
  app.get("/api/mcp/health", (c) => c.json({ status: "ok" }));
  return app;
}

describe("sandbox proxy response headers", () => {
  it("serves HTML that must not be cached", async () => {
    const res = await createApp().request(PROXY_PATH);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    // The document carries the host-origin allowlist for THIS deploy, so a
    // cached copy could outlive the configuration it was templated from.
    expect(res.headers.get("Cache-Control")).toBe(
      "no-cache, no-store, must-revalidate",
    );
  });

  it("allows the app origins to frame it, and drops X-Frame-Options", async () => {
    const res = await createApp().request(PROXY_PATH);
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("frame-ancestors 'self'");
    for (const pattern of SANDBOX_PROXY_LOCALHOST_PATTERNS) {
      expect(csp).toContain(pattern);
    }
    expect(res.headers.get("X-Frame-Options")).toBeNull();
  });

  it("frames-ancestors matches the origins the proxy pins against", async () => {
    // One source of truth: an origin allowed to frame the proxy but not to
    // talk to it renders a widget that then silently does nothing.
    const res = await createApp().request(PROXY_PATH);
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    for (const pattern of sandboxProxyHostOriginPatterns()) {
      expect(csp).toContain(pattern);
    }
  });

  it("leaves X-Frame-Options in place on ordinary routes", async () => {
    const res = await createApp().request("/api/mcp/health");
    expect(res.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
  });
});
