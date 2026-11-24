import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { localHostAllowlistMiddleware } from "../local-host-allowlist.js";
import { SERVER_PORT } from "../../config.js";
import {
  registerTunnelDomain,
  unregisterTunnelDomain,
} from "../../services/tunnel-registry.js";

function createApp() {
  const app = new Hono();
  app.use("*", localHostAllowlistMiddleware);
  app.all("*", (c) => c.json({ ok: true }));
  return app;
}

const requestAs = (host: string, path = "/api/mcp/servers") =>
  createApp().request(path, { headers: { Host: host } });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("localHostAllowlistMiddleware", () => {
  it.each([
    `localhost:${SERVER_PORT}`,
    `127.0.0.1:${SERVER_PORT}`,
    `[::1]:${SERVER_PORT}`,
    `LOCALHOST:${SERVER_PORT}`,
    // Loopback on another port: a remapped Docker port or a local proxy.
    `localhost:${SERVER_PORT + 1}`,
    "localhost",
  ])("answers %s", async (host) => {
    expect((await requestAs(host)).status).toBe(200);
  });

  it.each([
    // DNS rebinding: an attacker's name, pointed at loopback.
    `attacker.example:${SERVER_PORT}`,
    `localhost.attacker.example:${SERVER_PORT}`,
    `attacker.example@localhost:${SERVER_PORT}`,
  ])("refuses %s, documents and API alike", async (host) => {
    for (const path of ["/", "/api/mcp/servers"]) {
      const res = await requestAs(host, path);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe("HOST_NOT_ALLOWED");
      expect(body.message).toContain("MCPJAM_ALLOWED_HOSTS");
    }
  });

  it("admits only webhook POSTs from a proxy host", async () => {
    const app = createApp();
    const hook = "/api/mcp/events/hooks/my-server/i/abcdef/s/abcdef";
    const headers = { Host: "host.docker.internal:6274" };
    expect((await app.request(hook, { method: "POST", headers })).status).toBe(200);
    expect((await app.request(hook, { headers })).status).toBe(403);
    expect((await app.request(`${hook}/other`, { method: "POST", headers })).status).toBe(403);
    expect((await app.request("/api/mcp/events/subscriptions", { method: "POST", headers })).status).toBe(403);
  });

  it("honors the hosts and origins the instance is configured for", async () => {
    vi.stubEnv("MCPJAM_ALLOWED_HOSTS", "192.168.1.50,*.corp.example");
    vi.stubEnv("MCPJAM_PUBLIC_ORIGIN", "https://inspector.example.org");
    vi.stubEnv("BASE_URL", "http://devbox:7000");
    for (const host of [
      "192.168.1.50:6274",
      "lab.corp.example",
      "inspector.example.org",
      "devbox:7000",
    ]) {
      expect((await requestAs(host)).status).toBe(200);
    }
    expect((await requestAs("devbox:7001")).status).toBe(403);
  });

  it("answers a live tunnel's host", async () => {
    registerTunnelDomain("slug0001.tunnels.mcpjam.com", "srv");
    try {
      expect((await requestAs("slug0001.tunnels.mcpjam.com")).status).toBe(200);
    } finally {
      unregisterTunnelDomain("slug0001.tunnels.mcpjam.com");
    }
    expect((await requestAs("slug0001.tunnels.mcpjam.com")).status).toBe(403);
  });

  it("lets a request with no Host header through: it is not a browser's", async () => {
    expect((await createApp().request("/api/mcp/servers")).status).toBe(200);
  });
});
