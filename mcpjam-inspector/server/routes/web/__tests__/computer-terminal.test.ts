import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import { Sandbox } from "e2b";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { createComputerTerminalWsHandler } from "../computer-terminal.js";
import { resetComputerTerminalJwksCacheForTests } from "../../../utils/computers/terminal-token.js";

// Route-level tests for GET /api/web/computers/terminal. Auth mirrors
// computer-upload.test.ts (RS256 tokens verified against a stubbed JWKS at
// `/computers/terminal-jwks`, plus a fetch stub for the control-plane
// `/computers/sandbox-info` lookup), but the transport under test here is the
// WS handshake itself: a real http.Server + a real `ws` client, since the
// token rides the Sec-WebSocket-Protocol header.

vi.mock("e2b", async () => {
  const actual = await vi.importActual<typeof import("e2b")>("e2b");
  return { ...actual, Sandbox: { connect: vi.fn() } };
});

const ISSUER = "https://api.mcpjam.com/computer-terminal";
const CONVEX_URL = "https://convex.example";
const KID = "computer-terminal-1";

let signingKey: CryptoKey;
let jwksDoc: unknown;

beforeAll(async () => {
  const kp = await generateKeyPair("RS256");
  signingKey = kp.privateKey as CryptoKey;
  const jwk = await exportJWK(kp.publicKey);
  jwksDoc = { keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] };
});

async function signToken(claims: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const {
    iss = ISSUER,
    iat = now,
    exp = now + 60,
    ...rest
  } = {
    purpose: "computer-terminal",
    sub: "users_123",
    computerId: "computers_456",
    projectId: "projects_789",
    ...claims,
  } as Record<string, unknown> & { iss?: string; iat?: number; exp?: number };
  return new SignJWT(rest)
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(iss)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(signingKey);
}

function installSandboxInfoStub(
  providerComputerId: string | null = "sbx_42",
  overrides: { projectId?: string; ownerUserId?: string } = {}
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const path = new URL(String(url)).pathname;
      if (path === "/computers/sandbox-info") {
        return new Response(
          JSON.stringify({
            computerId: "computers_456",
            providerComputerId,
            provider: "e2b",
            status: providerComputerId ? "ready" : "provisioning",
            projectId: overrides.projectId ?? "projects_789",
            ownerUserId: overrides.ownerUserId ?? "users_123",
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (path === "/computers/terminal-sessions") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/computers/terminal-jwks") {
        return new Response(JSON.stringify(jwksDoc), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected path ${path}`);
    })
  );
}

function stubConfiguredEnv() {
  vi.stubEnv("CONVEX_HTTP_URL", CONVEX_URL);
  vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "test-svc-token");
  vi.stubEnv("E2B_API_KEY", "e2b_test");
  vi.stubEnv("COMPUTERS_TERMINAL_TOKEN_SECRET", "test-terminal-secret-0123456789");
}

async function startServer(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const app = new Hono();
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
  app.get(
    "/api/web/computers/terminal",
    createComputerTerminalWsHandler(upgradeWebSocket)
  );
  const server = http.createServer();
  injectWebSocket(server);
  // @hono/node-server's node adapter is overkill here; Hono apps are plain
  // fetch handlers, so a manual http.Server + app.fetch bridge is enough for
  // the non-upgrade path (none needed) and injectWebSocket owns "upgrade".
  server.on("request", async (req, res) => {
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function waitForClose(
  ws: WebSocket
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.on("close", (code, reason) =>
      resolve({ code, reason: reason.toString() })
    );
  });
}

function waitForMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve) => {
    ws.once("message", (data) => resolve(JSON.parse(data.toString())));
  });
}

describe("GET /api/web/computers/terminal", () => {
  let close: () => Promise<void>;
  let port: number;

  beforeEach(async () => {
    const started = await startServer();
    port = started.port;
    close = started.close;
  });

  afterEach(async () => {
    await close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetComputerTerminalJwksCacheForTests();
  });

  it("rejects a token only present in the ?token= query string", async () => {
    stubConfiguredEnv();
    installSandboxInfoStub();
    const token = await signToken();
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/api/web/computers/terminal?token=${token}&cols=80&rows=24`
    );
    const closed = await waitForClose(ws);
    expect(closed.code).toBe(4401);
  });

  it("rejects a connection with no token at all", async () => {
    stubConfiguredEnv();
    installSandboxInfoStub();
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/api/web/computers/terminal?cols=80&rows=24`
    );
    const closed = await waitForClose(ws);
    expect(closed.code).toBe(4401);
  });

  it("accepts a valid token sent as a WebSocket subprotocol", async () => {
    stubConfiguredEnv();
    // Still provisioning ⇒ closes 4503, distinct from the 4401 auth failure
    // above — proving the token was read, verified, and exchanged for
    // sandbox info via the subprotocol path alone.
    installSandboxInfoStub(null);
    const token = await signToken();
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/api/web/computers/terminal?cols=80&rows=24`,
      [token]
    );
    const closed = await waitForClose(ws);
    expect(closed.code).toBe(4503);
  });

  it("rejects when the sandbox-info row's owner doesn't match the token's claims", async () => {
    stubConfiguredEnv();
    // Row belongs to a different user than the token claims — e.g. the
    // computer's ownership changed after the token was minted.
    installSandboxInfoStub("sbx_42", { ownerUserId: "users_other" });
    const token = await signToken();
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/api/web/computers/terminal?cols=80&rows=24`,
      [token]
    );
    const closed = await waitForClose(ws);
    expect(closed.code).toBe(4401);
    expect(vi.mocked(Sandbox.connect)).not.toHaveBeenCalled();
  });

  it("rejects when the sandbox-info row's project doesn't match the token's claims", async () => {
    stubConfiguredEnv();
    installSandboxInfoStub("sbx_42", { projectId: "projects_other" });
    const token = await signToken();
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/api/web/computers/terminal?cols=80&rows=24`,
      [token]
    );
    const closed = await waitForClose(ws);
    expect(closed.code).toBe(4401);
    expect(vi.mocked(Sandbox.connect)).not.toHaveBeenCalled();
  });

  it("opens a PTY and records the terminal session for a subprotocol token", async () => {
    stubConfiguredEnv();
    installSandboxInfoStub("sbx_42");
    const fakePty = { pid: 1, wait: () => new Promise(() => {}) };
    const fakeSandbox = {
      pty: {
        create: vi.fn().mockResolvedValue(fakePty),
        resize: vi.fn().mockResolvedValue(undefined),
        sendInput: vi.fn().mockResolvedValue(undefined),
        kill: vi.fn().mockResolvedValue(undefined),
      },
    };
    vi.mocked(Sandbox.connect).mockResolvedValue(fakeSandbox as never);

    const token = await signToken();
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/api/web/computers/terminal?cols=80&rows=24`,
      [token]
    );
    const ready = (await waitForMessage(ws)) as {
      type: string;
      sessionId: string;
    };
    expect(ready.type).toBe("ready");
    expect(typeof ready.sessionId).toBe("string");

    ws.close();
    await waitForClose(ws);
    // onClose awaits recordTerminalSession before returning; give its
    // microtask a tick to settle before asserting the fetch stub saw it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const calls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes("/computers/terminal-sessions"))).toBe(
      true
    );
  });

  it("touches activity on stdin, throttled to once per window", async () => {
    stubConfiguredEnv();
    installSandboxInfoStub("sbx_42");
    const fakePty = { pid: 1, wait: () => new Promise(() => {}) };
    const fakeSandbox = {
      pty: {
        create: vi.fn().mockResolvedValue(fakePty),
        resize: vi.fn().mockResolvedValue(undefined),
        sendInput: vi.fn().mockResolvedValue(undefined),
        kill: vi.fn().mockResolvedValue(undefined),
      },
    };
    vi.mocked(Sandbox.connect).mockResolvedValue(fakeSandbox as never);

    const token = await signToken();
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/api/web/computers/terminal?cols=80&rows=24`,
      [token]
    );
    await waitForMessage(ws); // "ready"

    // Two keystrokes inside the same throttle window (60s) ⇒ one activity touch.
    ws.send(Buffer.from([0x61]));
    ws.send(Buffer.from([0x62]));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const touchCalls = vi.mocked(fetch).mock.calls.filter(([url, init]) => {
      if (!String(url).includes("/computers/terminal-sessions")) return false;
      try {
        return JSON.parse(String(init?.body)).action === "touch";
      } catch {
        return false;
      }
    });
    expect(touchCalls).toHaveLength(1);
    // The stdin still reached the PTY both times.
    expect(fakeSandbox.pty.sendInput).toHaveBeenCalledTimes(2);

    ws.close();
    await waitForClose(ws);
  });
});
