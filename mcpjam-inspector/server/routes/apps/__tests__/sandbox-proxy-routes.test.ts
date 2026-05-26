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
  });
});
