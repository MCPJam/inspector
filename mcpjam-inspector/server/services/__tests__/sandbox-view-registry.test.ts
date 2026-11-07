import { get } from "node:http";
import { createConnection } from "node:net";
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateSessionToken } from "../session-token.js";
import {
  prepareSandboxViewSchema,
  sandboxDigest,
  SANDBOX_VIEW_LEASE_MS,
} from "../sandbox-view-policy.js";
import { SandboxViewRegistry } from "../sandbox-view-registry.js";

// Node's OS resolver need not implement .localhost; browsers resolve it to
// loopback. Keep the original Host header while driving the actual listener.
function fetch(value: string | URL): Promise<Response> {
  const url = new URL(value);
  const host = url.host;
  url.hostname = "127.0.0.1";
  return new Promise((resolve, reject) => {
    get(url, { headers: { Host: host } }, (response) => {
      const body: Buffer[] = [];
      response.on("data", (chunk: Buffer) => body.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolve(new Response(Buffer.concat(body), {
        status: response.statusCode,
        headers: Object.fromEntries(Object.entries(response.headers).flatMap(
          ([key, value]) => typeof value === "string" ? [[key, value]] : [],
        )),
      })));
    }).on("error", reject);
  });
}

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
beforeEach(() => {
  generateSessionToken();
  now = Date.now();
  registry = new SandboxViewRegistry(() => now);
});
afterEach(() => {
  registry.close();
});

describe("local App document leases", () => {
  it("serves only the admitted document with HTTP policy and metadata, without App bytes", async () => {
    const request = input();
    const view = await registry.prepare(request, owner);
    const response = await fetch(view.proxyUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "connect-src 'none'",
    );
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'self' http://localhost:6274",
    );
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Origin-Agent-Cluster")).toBe("?1");
    const body = await response.text();
    expect(body).toContain(view.htmlSha256);
    expect(body).not.toContain(request.html);
    for (const path of [
      "/",
      "/api/session-token",
      "/health",
      "/assets/script.js",
    ]) {
      const denied = await fetch(new URL(path, view.proxyUrl));
      expect(denied.status).toBe(404);
      expect(denied.headers.get("Content-Security-Policy")).toContain(
        "default-src 'none'",
      );
    }
    const noCapability = new URL(view.proxyUrl);
    noCapability.search = "";
    expect((await fetch(noCapability)).status).toBe(404);
  });

  it("reuses a one-port pool across restarts without reusing browser authority", async () => {
    const first = await registry.prepare(input(), owner);
    const port = Number(new URL(first.proxyUrl).port);
    registry.close();
    for (let attempt = 0; attempt < 8; attempt++) {
      registry = new SandboxViewRegistry(() => now, port);
      const next = await registry.prepare(input(), owner);
      expect(new URL(next.proxyUrl).origin).not.toBe(new URL(first.proxyUrl).origin);
      expect(new URL(next.proxyUrl).port).toBe(String(port));
      expect((await fetch(next.proxyUrl)).status).toBe(200);
      expect((await fetch(first.proxyUrl)).status).toBe(404);
      const oldCapability = new URL(next.proxyUrl);
      oldCapability.search = new URL(first.proxyUrl).search;
      expect((await fetch(oldCapability)).status).toBe(404);
      registry.close();
    }
  });

  it("contains malformed absolute-form targets and keeps the listener usable", async () => {
    const view = await registry.prepare(input(), owner);
    const url = new URL(view.proxyUrl);
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = createConnection({
        host: "127.0.0.1",
        port: Number(url.port),
      });
      let text = "";
      socket.on("connect", () =>
        socket.write(
          `GET http://[ HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\n\r\n`,
        ),
      );
      socket.on("data", (data) => {
        text += data.toString();
      });
      socket.on("error", reject);
      socket.on("end", () => resolve(text));
    });
    expect(raw).toContain("404");
    expect(raw.toLowerCase()).toContain(
      "content-security-policy: default-src 'none'",
    );
    expect((await fetch(view.proxyUrl)).status).toBe(200);
  });

  it("coalesces identical starts, survives31 hidden minutes, and renews without changing URL", async () => {
    const request = input();
    const [first, duplicate] = await Promise.all([
      registry.prepare(request, owner),
      registry.prepare(request, owner),
    ]);
    expect(duplicate).toEqual(first);
    now += 31 * 60 * 1000;
    expect((await fetch(first.proxyUrl)).status).toBe(200);
    const renewed = await registry.prepare(
      { ...request, admissionId: first.admissionId },
      owner,
    );
    expect(renewed.proxyUrl).toBe(first.proxyUrl);
    expect(renewed.expiresAt).toBe(now + SANDBOX_VIEW_LEASE_MS);
    registry.dispose(first.admissionId, sandboxDigest("wrong-owner"));
    expect((await fetch(first.proxyUrl)).status).toBe(200);
    registry.dispose(first.admissionId, owner);
    await expect(fetch(first.proxyUrl)).rejects.toThrow();
  });

  it("refuses changed admission bytes and leaves expired documents closed", async () => {
    const request = input();
    const first = await registry.prepare(request, owner);
    await expect(
      registry.prepare({ ...request, html: request.html + "changed" }, owner),
    ).rejects.toThrow("changed");
    now += SANDBOX_VIEW_LEASE_MS + 1;
    expect((await fetch(first.proxyUrl)).status).toBe(404);
    await expect(
      registry.prepare({ ...request, admissionId: first.admissionId }, owner),
    ).rejects.toThrow("expired");
  });
});
