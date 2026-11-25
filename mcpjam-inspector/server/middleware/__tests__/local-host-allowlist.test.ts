import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { localHostAllowlistMiddleware } from "../local-host-allowlist.js";
import { originValidationMiddleware } from "../origin-validation.js";
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

/**
 * The webhook exception above skips the DNS-rebinding guard, which only ever
 * stopped browsers: any other client chooses its own Host. It stays safe
 * because the origin gate still sees every webhook POST, and a browser always
 * sends an Origin on a POST. These tests fail if that stops being true.
 */
describe("webhook Host exception behind the origin gate", () => {
  const hook = "/api/mcp/events/hooks/my-server/i/abcdef/s/abcdef";
  const rebound = `attacker.example:${SERVER_PORT}`;

  function createGatedApp() {
    const app = new Hono();
    // The entry points mount both gates in this order (checked below).
    app.use("*", localHostAllowlistMiddleware);
    app.use("*", originValidationMiddleware);
    app.all("*", (c) => c.json({ ok: true }));
    return app;
  }

  it.each([`http://${rebound}`, "null"])(
    "refuses a webhook POST from a rebinding page with Origin %s",
    async (origin) => {
      const res = await createGatedApp().request(hook, {
        method: "POST",
        headers: { Host: rebound, Origin: origin },
      });
      expect(res.status).toBe(403);
    },
  );

  it("admits a server's webhook POST, which carries no Origin", async () => {
    const res = await createGatedApp().request(hook, {
      method: "POST",
      headers: { Host: "host.docker.internal:6274" },
    });
    expect(res.status).toBe(200);
  });

  const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  it.each(["index.ts", "app.ts"])(
    "%s mounts the origin gate on every path before the MCP routes",
    (entry) => {
      const source = readFileSync(resolve(serverDir, entry), "utf8");
      const gate = source.indexOf('app.use("*", originValidationMiddleware);');
      const hostCheck = source.indexOf('app.use("*", localHostAllowlistMiddleware);');
      const routes = source.indexOf('app.route("/api/mcp", mcpRoutes);');
      expect(gate).toBeGreaterThan(-1);
      expect(hostCheck).toBeGreaterThan(-1);
      expect(routes).toBeGreaterThan(gate);
      expect(gate).toBeGreaterThan(hostCheck);
      // Not behind a condition on its line, as the Host check is: a gate
      // mounted only in some modes leaves the webhook route open in the others.
      const lineStart = source.lastIndexOf("\n", gate) + 1;
      expect(source.slice(lineStart, gate).trim()).toBe("");
    },
  );
});
