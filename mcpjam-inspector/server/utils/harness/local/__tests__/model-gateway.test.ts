import { mkdtemp, realpath, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  isAllowedPath,
  isLoopbackHost,
  startLocalModelGateway,
  type LocalModelGateway,
} from "../model-gateway.js";
import { resetInstanceKeyCacheForTests } from "../instance-key.js";

// A lease whose payload carries a jti. Not signed by anything — the gateway
// only reads the claim to bind its proof of possession to, and the backend is
// what verifies the token.
function fakeLease(jti: string): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256" })}.${encode({ jti })}.sig`;
}

let home: string;
let realHome: string | undefined;
const open: LocalModelGateway[] = [];

beforeAll(async () => {
  // The gateway signs with the machine's instance key, which is minted under
  // the harness-local state root on first use.
  home = await realpath(await mkdtemp(join(tmpdir(), "mcpjam-gateway-")));
  realHome = process.env.HOME;
  process.env.HOME = home;
  resetInstanceKeyCacheForTests();
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((gateway) => gateway.close()));
});

afterAll(async () => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  resetInstanceKeyCacheForTests();
  await rm(home, { recursive: true, force: true });
});

async function gateway(
  overrides: Partial<Parameters<typeof startLocalModelGateway>[0]> = {},
): Promise<LocalModelGateway> {
  const started = await startLocalModelGateway({
    lease: fakeLease("jti_test"),
    upstreamBaseUrl: "https://api.example.test/web/harness/model-proxy/anthropic",
    fetchImpl: async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ...overrides,
  });
  open.push(started);
  return started;
}

describe("the gateway's front door", () => {
  it("binds loopback on a port nobody predicted", async () => {
    const g = await gateway();
    expect(g.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(g.port).toBeGreaterThan(0);
  });

  it("hands the child a capability, never the lease", async () => {
    // The credential reaches the CLI as an environment variable and is
    // persisted in the bridge's start config. Whatever it is, it is written
    // down — so it is a per-session capability that means nothing off this
    // listener, not the lease.
    const lease = fakeLease("jti_secret");
    const g = await gateway({ lease });
    expect(g.sessionCapability).not.toContain(lease);
    expect(g.sessionCapability.length).toBeGreaterThan(30);
  });

  it("forwards an allowed request with the lease and a proof of possession", async () => {
    let seen: { url: string; headers: Headers } | null = null;
    const g = await gateway({
      lease: fakeLease("jti_forward"),
      fetchImpl: async (input, init) => {
        seen = {
          url: String(input),
          headers: new Headers(init?.headers as HeadersInit),
        };
        return new Response("{}", { status: 200 });
      },
    });
    const response = await fetch(`${g.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": g.sessionCapability,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "claude", messages: [] }),
    });
    expect(response.status).toBe(200);
    expect(seen).not.toBeNull();
    const captured = seen as unknown as { url: string; headers: Headers };
    expect(captured.url).toBe(
      "https://api.example.test/web/harness/model-proxy/anthropic/v1/messages",
    );
    expect(captured.headers.get("authorization")).toBe(
      `Bearer ${fakeLease("jti_forward")}`,
    );
    // `<ts>.<nonce>.<sig>` — the shape the backend parses.
    expect(captured.headers.get("x-mcpjam-pop")).toMatch(
      /^\d+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
    );
  });

  it("signs each request with a fresh nonce, so one signature is not reusable", async () => {
    const proofs: string[] = [];
    const g = await gateway({
      fetchImpl: async (_input, init) => {
        proofs.push(
          new Headers(init?.headers as HeadersInit).get("x-mcpjam-pop") ?? "",
        );
        return new Response("{}", { status: 200 });
      },
    });
    for (let i = 0; i < 3; i += 1) {
      await fetch(`${g.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": g.sessionCapability },
        body: "{}",
      });
    }
    expect(new Set(proofs).size).toBe(3);
  });
});

describe("what the gateway refuses", () => {
  it("refuses a request with no capability", async () => {
    const g = await gateway();
    const response = await fetch(`${g.baseUrl}/v1/messages`, {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(401);
  });

  it("refuses a wrong capability", async () => {
    const g = await gateway();
    const response = await fetch(`${g.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": "not-the-capability" },
      body: "{}",
    });
    expect(response.status).toBe(401);
  });

  it("refuses any Origin at all", async () => {
    // Nothing in a browser should be talking to this, so the presence of the
    // header is the signal — there is no origin that would be allowed.
    const g = await gateway();
    const response = await fetch(`${g.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": g.sessionCapability,
        origin: "https://app.mcpjam.com",
      },
      body: "{}",
    });
    expect(response.status).toBe(403);
  });

  it("refuses a Host that is not loopback, which is what a DNS rebind carries", async () => {
    // Raw HTTP: `fetch` treats Host as a forbidden header and silently drops an
    // override, so it cannot express the request this rule exists to refuse.
    const g = await gateway();
    const { status } = await rawRequest(g.port, {
      method: "POST",
      path: "/v1/messages",
      headers: {
        host: "rebound.attacker.example",
        "x-api-key": g.sessionCapability,
      },
      body: "{}",
    });
    expect(status).toBe(403);
  });

  it("refuses a path outside the allowlist even with a valid capability", async () => {
    // It is an adapter for one upstream, not a proxy.
    const g = await gateway();
    for (const path of ["/v1/models", "/", "/v1/complete", "/../admin"]) {
      const response = await fetch(`${g.baseUrl}${path}`, {
        method: "POST",
        headers: { "x-api-key": g.sessionCapability },
        body: "{}",
      });
      expect(response.status).toBe(404);
    }
  });

  it("refuses everything once revoked", async () => {
    const g = await gateway();
    g.revoke();
    const response = await fetch(`${g.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": g.sessionCapability },
      body: "{}",
    });
    expect(response.status).toBe(401);
  });

  it("refuses a caller outside the supervised tree", async () => {
    // The capability reaches the child in its environment and is written to the
    // bridge's start config, so "knows the capability" is weaker than we would
    // like. This narrows it to processes we started.
    const g = await gateway({
      isSupervisedPid: (pid) => pid === 999_999,
      resolvePeerPid: async () => 12_345,
    });
    const response = await fetch(`${g.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": g.sessionCapability },
      body: "{}",
    });
    expect(response.status).toBe(403);
  });

  it("does not refuse when the platform cannot name the peer", async () => {
    // A narrowing check on top of the capability, not a replacement for it:
    // a platform that cannot answer must not cost the user the feature.
    const g = await gateway({
      isSupervisedPid: () => false,
      resolvePeerPid: async () => null,
    });
    const response = await fetch(`${g.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": g.sessionCapability },
      body: "{}",
    });
    expect(response.status).toBe(200);
  });

  it("refuses a body past the ceiling on its declared length alone", async () => {
    // Refused before a byte of it is read. Raw HTTP again: undici validates
    // content-length against the body it is given, so it cannot send the
    // oversized declaration this rule short-circuits on.
    const g = await gateway();
    const { status } = await rawRequest(g.port, {
      method: "POST",
      path: "/v1/messages",
      headers: {
        "x-api-key": g.sessionCapability,
        "content-length": String(64 * 1024 * 1024),
      },
      body: "{}",
      halfClose: true,
    });
    expect(status).toBe(413);
  });

  it("answers the CLI's reachability probe without a capability", async () => {
    // The CLI probes this before its first request. A 401 there is noise, and
    // may feed its own "is the API reachable" heuristics.
    const g = await gateway();
    const response = await fetch(`${g.baseUrl}/api/hello`, { method: "HEAD" });
    expect(response.status).toBe(200);
  });

  it("reports an upstream failure as 502 without leaking its detail", async () => {
    const g = await gateway({
      fetchImpl: async () => {
        throw new Error("upstream said something with a secret in it");
      },
    });
    const response = await fetch(`${g.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": g.sessionCapability },
      body: "{}",
    });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("secret");
  });
});

/**
 * A request built by hand on a socket.
 *
 * `fetch` refuses to send some of the shapes these rules exist to refuse — a
 * forged Host, a content-length that lies — so the tests that cover them speak
 * HTTP directly rather than asserting on a request the client rewrote.
 */
function rawRequest(
  port: number,
  args: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: string;
    halfClose?: boolean;
  },
): Promise<{ status: number }> {
  return new Promise((resolvePromise, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      const headers = { ...args.headers };
      // HTTP/1.1 requires a Host; without one Node answers 400 before the
      // gateway ever sees the request.
      if (headers.host === undefined) headers.host = `127.0.0.1:${port}`;
      if (headers["content-length"] === undefined) {
        headers["content-length"] = String(Buffer.byteLength(args.body));
      }
      const head = [
        `${args.method} ${args.path} HTTP/1.1`,
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        "",
        "",
      ].join("\r\n");
      socket.write(head);
      // With `halfClose` the declared length is deliberately never satisfied:
      // the gateway must answer from the declaration alone rather than waiting
      // for 64 MB that will never arrive.
      if (args.halfClose !== true) socket.write(args.body);
    });
    let buffer = "";
    socket.setTimeout(5_000, () => {
      socket.destroy();
      reject(new Error("raw request timed out"));
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const match = /^HTTP\/1\.1 (\d{3})/.exec(buffer);
      if (match !== null) {
        socket.destroy();
        resolvePromise({ status: Number(match[1]) });
      }
    });
    socket.on("error", reject);
  });
}

describe("the host and path rules on their own", () => {
  it.each([
    ["127.0.0.1:1234", true],
    ["localhost:1234", true],
    ["127.0.0.1", true],
    ["[::1]:1234", true],
    ["127.5.5.5:80", true],
    ["app.mcpjam.com", false],
    ["evil.example:127.0.0.1", false],
    [undefined, false],
  ])("isLoopbackHost(%s)", (host, expected) => {
    expect(isLoopbackHost(host as string | undefined)).toBe(expected);
  });

  it.each([
    ["POST", "/v1/messages", true],
    ["POST", "/v1/messages?beta=1", true],
    ["POST", "/v1/messages/count_tokens", true],
    ["POST", "/v1/messagesX", false],
    ["GET", "/v1/messages", false],
    ["POST", "/v1/models", false],
  ])("isAllowedPath(%s %s)", (method, path, expected) => {
    expect(isAllowedPath(method, path)).toBe(expected);
  });
});
