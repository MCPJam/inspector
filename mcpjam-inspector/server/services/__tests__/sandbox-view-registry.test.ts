// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { generateSessionToken } from "../session-token.js";
import {
  prepareSandboxViewSchema,
  sandboxDigest,
  SANDBOX_VIEW_LEASE_MS,
} from "../sandbox-view-policy.js";
import { SandboxViewRegistry } from "../sandbox-view-registry.js";

const owner = sandboxDigest("owner");
const input = () =>
  prepareSandboxViewSchema.parse({
    viewInstanceId: "639f5fd0-f977-4813-b90f-d57cf2bf7c46",
    source: {
      serverId: "server",
      resourceUri: "ui://view",
      toolCallId: "call",
    },
    html: "<!doctype html><p>view</p>",
    mode: "declared",
    hostOrigin: "http://localhost:6274",
    policy: { permissive: false },
  });
let now: number;
let registry: SandboxViewRegistry;

/** A browser request: the Host header carries the URL's host. */
function request(
  value: string | URL,
  init: { method?: string; host?: string } = {},
): Request {
  const url = new URL(value);
  return new Request(url, {
    method: init.method ?? "GET",
    headers: { host: init.host ?? url.host },
  });
}
function respond(value: string | URL, init?: { method?: string; host?: string }) {
  const response = registry.respond(request(value, init));
  if (!response) throw new Error("expected the App partition to answer");
  return response;
}

beforeEach(() => {
  generateSessionToken();
  now = Date.now();
  registry = new SandboxViewRegistry(() => now);
});

describe("local App document leases", () => {
  it("serves the admitted document on the Inspector's port with HTTP policy and no App bytes", async () => {
    const request = input();
    const view = await registry.prepare(request, owner, "6274");
    const url = new URL(view.proxyUrl);
    expect(url.hostname).toBe(`${view.admissionId}.localhost`);
    expect(url.port).toBe("6274");
    const response = respond(view.proxyUrl);
    expect(response.status).toBe(200);
    const policy = response.headers.get("Content-Security-Policy");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("frame-ancestors 'self' http://localhost:6274");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Origin-Agent-Cluster")).toBe("?1");
    expect(response.headers.get("X-Frame-Options")).toBeNull();
    const body = await response.text();
    expect(body).toContain(view.htmlSha256);
    expect(body).not.toContain(request.html);
  });

  it("answers every other request to an App host with a restrictive 404", async () => {
    const view = await registry.prepare(input(), owner, "6274");
    const denied = [
      ...["/", "/api/session-token", "/health", "/assets/script.js"].map(
        (path) => respond(new URL(path, view.proxyUrl)),
      ),
      respond(view.proxyUrl, { method: "POST" }),
      respond(view.proxyUrl, { method: "HEAD" }),
      respond(view.proxyUrl, { host: `${view.admissionId}.localhost:8080` }),
      respond(view.proxyUrl, { host: `${view.admissionId}.localhost.:6274` }),
      respond(`http://${crypto.randomUUID()}.localhost:6274/api/session-token`),
      respond(`${new URL(view.proxyUrl).origin}/api/apps/mcp-apps/sandbox-proxy`),
    ];
    for (const response of denied) {
      expect(response.status).toBe(404);
      expect(response.headers.get("Content-Security-Policy")).toContain(
        "default-src 'none'",
      );
    }
  });

  it("matches the App host case-insensitively and leaves the Inspector's own hosts alone", async () => {
    const view = await registry.prepare(input(), owner, "6274");
    const upper = new URL(view.proxyUrl).host.toUpperCase();
    expect(respond(view.proxyUrl, { host: upper }).status).toBe(200);
    for (const host of [
      "inspector.localhost:6274",
      `x.${view.admissionId}.localhost:6274`,
      "localhost:6274",
      "127.0.0.1:6274",
      "[::1]:6274",
      "localhost",
      "inspector.example.com",
    ])
      expect(
        registry.respond(request(`http://${host}/api/session-token`)),
      ).toBeNull();
  });

  it("omits a default port from the App origin", async () => {
    const view = await registry.prepare(input(), owner, "");
    expect(new URL(view.proxyUrl).origin).toBe(
      `http://${view.admissionId}.localhost`,
    );
    expect(respond(view.proxyUrl).status).toBe(200);
    await expect(
      registry.prepare({ ...input(), viewInstanceId: crypto.randomUUID() }, owner, "x"),
    ).rejects.toThrow("port");
  });

  it("coalesces identical starts and renews without changing URL", async () => {
    const request = input();
    const [first, duplicate] = await Promise.all([
      registry.prepare(request, owner, "6274"),
      registry.prepare(request, owner, "6274"),
    ]);
    expect(duplicate).toEqual(first);
    now += 31 * 60 * 1000;
    expect(respond(first.proxyUrl).status).toBe(200);
    const renewed = await registry.prepare(
      { ...request, admissionId: first.admissionId },
      owner,
      "6274",
    );
    expect(renewed.proxyUrl).toBe(first.proxyUrl);
    expect(renewed.expiresAt).toBe(now + SANDBOX_VIEW_LEASE_MS);
    registry.dispose(first.admissionId, sandboxDigest("wrong-owner"));
    expect(respond(first.proxyUrl).status).toBe(200);
    registry.dispose(first.admissionId, owner);
    expect(respond(first.proxyUrl).status).toBe(404);
  });

  it("gives a new admission a new origin and refuses the old capability", async () => {
    const first = await registry.prepare(input(), owner, "6274");
    registry = new SandboxViewRegistry(() => now);
    const next = await registry.prepare(input(), owner, "6274");
    expect(new URL(next.proxyUrl).origin).not.toBe(new URL(first.proxyUrl).origin);
    expect(respond(next.proxyUrl).status).toBe(200);
    expect(respond(first.proxyUrl).status).toBe(404);
    const oldCapability = new URL(next.proxyUrl);
    oldCapability.search = new URL(first.proxyUrl).search;
    expect(respond(oldCapability).status).toBe(404);
  });

  it("refuses changed admission bytes and leaves expired documents closed", async () => {
    const request = input();
    const first = await registry.prepare(request, owner, "6274");
    await expect(
      registry.prepare({ ...request, html: request.html + "changed" }, owner, "6274"),
    ).rejects.toThrow("changed");
    now += SANDBOX_VIEW_LEASE_MS + 1;
    expect(respond(first.proxyUrl).status).toBe(404);
    await expect(
      registry.prepare({ ...request, admissionId: first.admissionId }, owner, "6274"),
    ).rejects.toThrow("expired");
  });
});
