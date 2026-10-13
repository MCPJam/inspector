import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let app: any;
let token: string;
let resources: string;
beforeAll(async () => {
  vi.resetModules();
  resources = mkdtempSync(join(tmpdir(), "inspector-document-"));
  mkdirSync(join(resources, "client"));
  writeFileSync(
    join(resources, "client", "index.html"),
    "<!doctype html><html><head><title>Inspector</title></head><body>test document</body></html>",
  );
  vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "false");
  vi.stubEnv("MCPJAM_ALLOWED_HOSTS", "192.168.1.50,*.tunnels.mcpjam.com");
  vi.stubEnv("ELECTRON_APP", "true");
  vi.stubEnv("IS_PACKAGED", "true");
  vi.stubEnv("ELECTRON_RESOURCES_PATH", resources);
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("CONVEX_HTTP_URL", "https://test.convex.site");
  const { createHonoApp } = await import("../app.js");
  app = (await createHonoApp()).app;
  token = (await import("../services/session-token.js")).getSessionToken()!;
  expect(token.length).toBeGreaterThan(23);
}, 120_000);
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(resources, { recursive: true, force: true });
});

describe("session credentials are never delivered over HTTP", () => {
  const cases = [
    { Host: "localhost:6274" },
    { Host: "localhost:6274", "X-Forwarded-Host": "a.tunnels.mcpjam.com" },
    { Host: "localhost:6274", "X-Forwarded-For": "198.51.100.1" },
    { Host: "192.168.1.50:6274" },
    { Host: "a.tunnels.mcpjam.com" },
  ];
  it.each(cases)("refuses credential acquisition with %j", async (headers) => {
    const response = await app.request("/api/session-token", { headers });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      code: "ACCESS_LINK_REQUIRED",
    });
  });
  it("denies unconfigured hosts", async () => {
    expect(
      (
        await app.request("/api/session-token", {
          headers: { Host: "evil.example" },
        })
      ).status,
    ).toBe(403);
  });
  it("only confirms a credential already held by the caller", async () => {
    const response = await app.request("/api/session-token", {
      headers: { Host: "localhost", "X-MCP-Session-Auth": `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it.each(["/", "/testest"])(
    "serves real production HTML without a credential at %s",
    async (path) => {
      for (const headers of cases) {
        const response = await app.request(path, { headers });
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("test document");
        expect(html).not.toContain(token);
        expect(html).not.toContain("__MCP_SESSION_TOKEN__");
      }
    },
  );
});
