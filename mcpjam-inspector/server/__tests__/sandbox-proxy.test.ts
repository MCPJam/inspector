/** Unsigned document routes refuse a bootstrap behind the real security middleware. */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import mcpAppsRoutes from "../routes/apps/mcp-apps/index.js";
import { securityHeadersMiddleware } from "../middleware/security-headers.js";
import { SANDBOX_VIEW_DENY_POLICY } from "../utils/sandbox-view-response.js";

const PROXY_PATH = "/api/apps/mcp-apps/sandbox-proxy";

function createApp(): Hono {
  const app = new Hono();
  app.use("*", securityHeadersMiddleware);
  app.route("/api/apps/mcp-apps", mcpAppsRoutes);
  app.get("/api/mcp/health", (c) => c.json({ status: "ok" }));
  return app;
}

describe("sandbox proxy response headers", () => {
  it.each([PROXY_PATH, `${PROXY_PATH}?view_token=forged`])(
    "refuses an unsigned bootstrap at %s without caching or framing it",
    async (path) => {
      const res = await createApp().request(path);
      expect(res.status).toBe(403);
      expect(res.headers.get("Content-Type")).toBe("text/plain; charset=UTF-8");
      expect(res.headers.get("Cache-Control")).toBe("no-store, max-age=0");
      expect(res.headers.get("Content-Security-Policy")).toBe(SANDBOX_VIEW_DENY_POLICY);
      expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(await res.text()).not.toContain("<script");
    },
  );

  it("leaves X-Frame-Options in place on ordinary routes", async () => {
    const res = await createApp().request("/api/mcp/health");
    expect(res.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
  });
});
