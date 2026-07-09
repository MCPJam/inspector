import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import { Sandbox } from "e2b";
import { createComputerTerminalWsHandler } from "../computer-terminal.js";

// Route-level tests for GET /api/web/computers/terminal. Auth mirrors
// computer-upload.test.ts (locally-signed HS256 tokens, a fetch stub for the
// control-plane `/computers/sandbox-info` lookup), but the transport under
// test here is the WS handshake itself: a real http.Server + a real `ws`
// client, since the token now rides the Sec-WebSocket-Protocol header
// instead of a fetch-able query string.

vi.mock("e2b", async () => {
  const actual = await vi.importActual<typeof import("e2b")>("e2b");
  return { ...actual, Sandbox: { connect: vi.fn() } };
});

const SECRET = "test-terminal-secret-0123456789";
const ISSUER = "https://api.mcpjam.com/computer-terminal";
const CONVEX_URL = "https://convex.example";

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function signToken(
  claims: Record<string, unknown> = {},
  secret = SECRET
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const full = {
    iss: ISSUER,
    purpose: "computer-terminal",
    sub: "users_123",
    computerId: "computers_456",
    projectId: "projects_789",
    iat: now,
    exp: now + 60,
    ...claims,
  };
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const header = b64url(
    new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  );
  const payload = b64url(new TextEncoder().encode(JSON.stringify(full)));
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${header}.${payload}`)
  );
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
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
      throw new Error(`unexpected path ${path}`);
    })
  );
}

function stubConfiguredEnv() {
  vi.stubEnv("CONVEX_HTTP_URL", CONVEX_URL);
  vi.stubEnv("COMPUTERS_DATA_PLANE_SECRET", "test-secret");
  vi.stubEnv("E2B_API_KEY", "e2b_test");
  vi.stubEnv("COMPUTERS_TERMINAL_TOKEN_SECRET", SECRET);
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
});
