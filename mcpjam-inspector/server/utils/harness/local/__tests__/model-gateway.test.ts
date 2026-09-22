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

  it("cannot be walked out of its upstream prefix with dot segments", async () => {
    // `isAllowedPath` is a prefix test, and `new URL()` normalizes. Between the
    // two, `/v1/messages/../../…` passes the allowlist as a string and then
    // resolves to somewhere else entirely on the upstream origin — with the
    // real lease attached and a proof of possession signed over the path it
    // walked to. `fetch` normalizes client-side, so this speaks HTTP directly.
    let forwardedTo: string | null = null;
    const g = await gateway({
      fetchImpl: async (input) => {
        forwardedTo = String(input);
        return new Response("{}", { status: 200 });
      },
    });
    for (const path of [
      "/v1/messages/../../../../v1/admin",
      "/v1/messages/..%2f..%2fadmin",
      "/v1/messages/./../../keys",
      "/v1/messages/count_tokens/../../../../org",
    ]) {
      const { status } = await rawRequest(g.port, {
        method: "POST",
        path,
        headers: { "x-api-key": g.sessionCapability },
        body: "{}",
      });
      expect({ path, status }).toEqual({ path, status: 404 });
    }
    expect(forwardedTo).toBeNull();
  });

  it("keeps forwarding the ordinary paths the CLI actually sends", async () => {
    // The other half of the rule above: refusing dot segments must not refuse
    // the request shapes that exist. `/v1/messages?beta=…` and the
    // count_tokens sibling are what the adapter emits.
    const forwarded: string[] = [];
    const g = await gateway({
      fetchImpl: async (input) => {
        forwarded.push(String(input));
        return new Response("{}", { status: 200 });
      },
    });
    for (const path of [
      "/v1/messages",
      "/v1/messages?beta=true",
      "/v1/messages/count_tokens",
    ]) {
      const { status } = await rawRequest(g.port, {
        method: "POST",
        path,
        headers: { "x-api-key": g.sessionCapability },
        body: "{}",
      });
      expect({ path, status }).toEqual({ path, status: 200 });
    }
    expect(forwarded).toEqual([
      "https://api.example.test/web/harness/model-proxy/anthropic/v1/messages",
      "https://api.example.test/web/harness/model-proxy/anthropic/v1/messages?beta=true",
      "https://api.example.test/web/harness/model-proxy/anthropic/v1/messages/count_tokens",
    ]);
  });

  it("never follows a redirect, because two of the three lease headers survive one", async () => {
    // The fetch spec strips `Authorization` on a cross-origin redirect. It does
    // not strip `x-mcpjam-harness-lease`, which carries the same secret, nor
    // the proof of possession. So the redirect is refused rather than followed.
    let redirectMode: RequestRedirect | undefined;
    const g = await gateway({
      fetchImpl: async (_input, init) => {
        redirectMode = init?.redirect;
        return new Response("{}", { status: 200 });
      },
    });
    await fetch(`${g.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": g.sessionCapability },
      body: "{}",
    });
    expect(redirectMode).toBe("error");
  });

  it("refuses an upstream that is neither https nor loopback", async () => {
    // The lease travels as a bearer token on every forwarded request. A
    // plaintext upstream that is not on this machine puts it on the wire.
    await expect(
      startLocalModelGateway({
        lease: fakeLease("jti_plain"),
        upstreamBaseUrl: "http://api.example.test/proxy",
      }),
    ).rejects.toThrow(/https/i);
    // Loopback stays allowed: the conformance harness's mock upstream is
    // plain http on 127.0.0.1, and nothing leaves the machine.
    const local = await gateway({
      upstreamBaseUrl: "http://127.0.0.1:9/proxy",
    });
    expect(local.port).toBeGreaterThan(0);
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

describe("what the gateway does while a generation is streaming", () => {
  /** A response body that emits on demand and reports being cancelled. */
  function countedStream(chunk: Buffer, chunks: number, perChunkMs = 0) {
    const state = { pulled: 0, cancelled: false };
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (state.pulled >= chunks) {
          controller.close();
          return;
        }
        state.pulled += 1;
        // A generation arrives over time. `perChunkMs` is what makes that true
        // here, so a test about an ABANDONED stream cannot accidentally race a
        // stream that already finished.
        if (perChunkMs > 0) {
          await new Promise((r) => setTimeout(r, perChunkMs));
        }
        controller.enqueue(new Uint8Array(chunk));
      },
      cancel() {
        state.cancelled = true;
      },
    });
    return { state, body };
  }

  /** Sends a request and deliberately never reads the response. */
  function requestWithoutReading(
    port: number,
    capability: string,
  ): Promise<import("node:net").Socket> {
    return new Promise((resolvePromise) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(
          [
            "POST /v1/messages HTTP/1.1",
            `host: 127.0.0.1:${port}`,
            `x-api-key: ${capability}`,
            "content-length: 2",
            "",
            "{}",
          ].join("\r\n"),
        );
        resolvePromise(socket);
      });
      // No `data` handler and no resume: the socket stays paused, the receive
      // window closes, and the gateway's writes stop being drained — which is
      // exactly the slow reader this is about.
      socket.on("error", () => {});
    });
  }

  it("stops pulling from upstream when the client stops reading", async () => {
    // Without backpressure the whole generation is pulled at memory speed and
    // buffered in this process — 64 MB here, an unbounded transcript in
    // production — while the CLI is still working through the first chunk.
    const { state, body } = countedStream(Buffer.alloc(512 * 1024, 0x61), 128);
    const g = await gateway({
      fetchImpl: async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    });
    const socket = await requestWithoutReading(g.port, g.sessionCapability);
    await new Promise((r) => setTimeout(r, 750));
    const pulled = state.pulled;
    socket.destroy();
    expect(pulled).toBeLessThan(64);
  });

  it("cancels the upstream generation when the client goes away", async () => {
    // A cancelled turn must stop costing tokens. If nothing cancels the reader,
    // the upstream keeps generating — and keeps metering — against a response
    // nobody will ever read.
    // 20 ms a chunk for 5 000 chunks: a hundred seconds of generation, so the
    // only way this stream ends inside the test is by being cancelled.
    const { state, body } = countedStream(Buffer.alloc(64, 0x61), 5_000, 20);
    const g = await gateway({
      fetchImpl: async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    });
    const socket = await requestWithoutReading(g.port, g.sessionCapability);
    await new Promise((r) => setTimeout(r, 100));
    socket.destroy();
    const deadline = Date.now() + 2_000;
    while (!state.cancelled && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(state.cancelled).toBe(true);
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
    // Anything that changes meaning when the URL is resolved. The prefix test
    // alone would pass all of these.
    ["POST", "/v1/messages/../admin", false],
    ["POST", "/v1/messages/./../../admin", false],
    ["POST", "/v1/messages/%2e%2e/admin", false],
    ["POST", "/v1/messages/..%2fadmin", false],
    ["POST", "/v1/messages/sub/../ok", false],
    ["POST", "/v1/messages\\..\\admin", false],
    ["POST", "/v1/messages/%zz", false],
    ["POST", "/v1/messages/../admin?ok=1", false],
    // …and the shapes that are merely unusual, which stay allowed: a dot is
    // only a dot when it is the WHOLE segment.
    ["POST", "/v1/messages/..beta", true],
    ["POST", "/v1/messages/a..b", true],
    ["POST", "/v1/messages/count_tokens?beta=x", true],
  ])("isAllowedPath(%s %s)", (method, path, expected) => {
    expect(isAllowedPath(method, path)).toBe(expected);
  });
});
