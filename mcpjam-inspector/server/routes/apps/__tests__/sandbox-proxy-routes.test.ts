import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import mcpAppsRoutes from "../mcp-apps";

describe("Sandbox proxy routes", () => {
  it("serves MCP Apps sandbox proxy HTML", async () => {
    const app = new Hono();
    app.route("/api/apps/mcp-apps", mcpAppsRoutes);

    const res = await app.request("/api/apps/mcp-apps/sandbox-proxy");
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(body.toLowerCase()).toContain("<!doctype html>");
    expect(body).toContain('<meta name="color-scheme" content="light dark"');
    expect(body).toContain("background: transparent");
    expect(body).toContain("function applyColorScheme");
    expect(body).toContain("color-scheme: light dark");
    expect(body).toContain("ui/notifications/sandbox-color-scheme-changed");
    expect(body).toContain('const RECORDER_SHIM = "(function(){');
    expect(body).toContain("recorderBootstrap();");
    expect(body).toContain("var __name = function(target) { return target; };");
    expect(body).toContain('(guardScript || "") +');
    expect(body).toContain("cspMeta +");
    expect(body).toContain("violationListener;");
    // The view is mounted by document.write into a fresh frame, never by
    // assigning the processed HTML to srcdoc (that path is the opaque-origin
    // fallback inside mountInner only).
    expect(body).toContain("function mountInner");
    expect(body).toContain("function createInnerFrame");
    expect(body).not.toContain("inner.srcdoc = processedHtml");
    expect(body).not.toContain("recorder:proxy-status");
    expect(body).not.toContain(
      'const RECORDER_SHIM = "__MCPJAM_RECORDER_SHIM__";'
    );
    // Load-bearing: an unreplaced host-origin placeholder makes the proxy
    // accept a message from ANY parent (it fails open on purpose, to preserve
    // pre-pinning behavior rather than render nothing). This assertion is what
    // keeps a real build from shipping that way.
    expect(body).not.toContain(
      'const HOST_ORIGIN_PATTERNS = "__MCPJAM_HOST_ORIGINS__";'
    );
    expect(body).toContain('"http://127.0.0.1:*"');
    expect(body).toContain("function hostOriginAllowed");
  });
});
