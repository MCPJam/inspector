import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import type { SandboxViewRegistry } from "../services/sandbox-view-registry.js";

/**
 * The desktop app's server (`createHonoApp`) answers `localhost` subdomains
 * from the App partition before any other middleware or route. The standalone
 * server mounts the same call; entrypoint-parity.test.ts keeps them in step.
 */
let app: Hono;
let views: SandboxViewRegistry;
let resources: string;
beforeAll(async () => {
  vi.resetModules();
  resources = mkdtempSync(join(tmpdir(), "inspector-app-host-"));
  mkdirSync(join(resources, "client"));
  writeFileSync(
    join(resources, "client", "index.html"),
    "<!doctype html><html><head><title>Inspector</title></head><body>app shell</body></html>",
  );
  vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "false");
  vi.stubEnv("ELECTRON_APP", "true");
  vi.stubEnv("IS_PACKAGED", "true");
  vi.stubEnv("ELECTRON_RESOURCES_PATH", resources);
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("CONVEX_HTTP_URL", "https://test.convex.site");
  const { createHonoApp } = await import("../app.js");
  app = (await createHonoApp()).app;
  views = (await import("../services/sandbox-view-registry.js")).sandboxViews;
}, 120_000);
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(resources, { recursive: true, force: true });
});

async function admit() {
  const { prepareSandboxViewSchema, sandboxDigest } = await import(
    "../services/sandbox-view-policy.js"
  );
  return views.prepare(
    prepareSandboxViewSchema.parse({
      viewInstanceId: crypto.randomUUID(),
      source: { serverId: "server", resourceUri: "ui://view", toolCallId: "call" },
      html: "<!doctype html><p>view</p>",
      mode: "declared",
      hostOrigin: "http://127.0.0.1:6274",
      policy: { permissive: false },
    }),
    sandboxDigest("owner"),
    "6274",
  );
}
function get(url: string, host = new URL(url).host) {
  const { pathname, search } = new URL(url);
  return app.request(`http://${host}${pathname}${search}`, {
    headers: { Host: host },
  });
}

describe("App documents on the Inspector port", () => {
  it("serves an admitted document with only its own headers", async () => {
    const view = await admit();
    const response = await get(view.proxyUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Frame-Options")).toBeNull();
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'self' http://127.0.0.1:6274",
    );
    expect(await response.text()).toContain(view.htmlSha256);
  });

  it("never lets an App host reach the app shell, assets or API", async () => {
    const view = await admit();
    const origin = new URL(view.proxyUrl).origin;
    for (const path of ["/", "/api/session-token", "/health", "/api/mcp/servers"]) {
      const response = await get(`${origin}${path}`);
      expect(response.status).toBe(404);
      expect(response.headers.get("Content-Security-Policy")).toContain(
        "default-src 'none'",
      );
    }
  });

  it("refuses a WebSocket upgrade on an App host", async () => {
    const view = await admit();
    const origin = new URL(view.proxyUrl);
    const response = await app.request(`http://${origin.host}/api/mcp/servers/rpc/stream`, {
      headers: { Host: origin.host, Connection: "Upgrade", Upgrade: "websocket" },
    });
    expect(response.status).toBe(404);
  });

  it("leaves the Inspector's own host to the rest of the stack", async () => {
    const response = await get("http://localhost:6274/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
  });
});
