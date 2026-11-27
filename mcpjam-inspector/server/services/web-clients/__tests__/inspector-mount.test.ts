import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startFixtureServer } from "./forwarding-fixtures.js";

/**
 * The desktop app's real server, as `createHonoApp` builds it: the endpoint
 * must answer ahead of its security, CORS, indexing and host checks.
 */
let app: Hono;
let resources: string;
let fixture: Awaited<ReturnType<typeof startFixtureServer>>;
let path: string;
beforeAll(async () => {
  vi.resetModules();
  fixture = await startFixtureServer();
  resources = mkdtempSync(join(tmpdir(), "inspector-web-clients-"));
  mkdirSync(join(resources, "client"));
  writeFileSync(join(resources, "client", "index.html"), "<!doctype html><p>app shell</p>");
  // A local connector registered without a signed-in person answers to the flag file.
  writeFileSync(join(resources, "flags.json"), JSON.stringify({ "web-clients-enabled": true }));
  vi.stubEnv("MCPJAM_FEATURE_FLAGS_FILE", join(resources, "flags.json"));
  vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "false");
  vi.stubEnv("ELECTRON_APP", "true");
  vi.stubEnv("IS_PACKAGED", "true");
  vi.stubEnv("ELECTRON_RESOURCES_PATH", resources);
  vi.stubEnv("NODE_ENV", "test");
  // Required to boot; without the service credential the backend is never asked.
  vi.stubEnv("CONVEX_HTTP_URL", "https://test.convex.site");
  const { createHonoApp } = await import("../../../app.js");
  app = (await createHonoApp()).app;
  const { localWebConnectors } = await import("../local-connectors.js");
  const connector = localWebConnectors.register({ upstreamUrl: fixture.url });
  path = `/mcp/${connector.connectorId}`;
}, 120_000);
afterAll(async () => {
  vi.unstubAllEnvs();
  rmSync(resources, { recursive: true, force: true });
  await fixture.close();
});

function headerNames(response: Response): string[] {
  const names: string[] = [];
  response.headers.forEach((_value, name) => names.push(name));
  return names.sort();
}

describe("the endpoint inside the real app", () => {
  it("answers on a tunnel host with only the server's MCP headers", async () => {
    const response = await app.request(`https://tunnel.example.test${path}`, {
      method: "POST",
      headers: {
        Host: "tunnel.example.test",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 1, result: { tools: [{ name: "echo" }] } });
    expect(headerNames(response)).toEqual(["content-type", "mcp-session-id"]);
  });

  it("leaves every other path to the app's own stack", async () => {
    const response = await app.request("http://localhost:6274/mcp", {
      headers: { Host: "localhost:6274" },
    });
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
