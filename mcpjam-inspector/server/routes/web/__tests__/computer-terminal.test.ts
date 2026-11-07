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
import { attachComputerSandbox } from "../../../utils/computers/attach-computer.js";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { reportRouteFailure } from "../../../utils/route-error-report.js";
import { requestLogContextMiddleware } from "../../../middleware/request-log-context.js";
import { createComputerTerminalWsHandler } from "../computer-terminal.js";
import { resetComputerTerminalJwksCacheForTests } from "../../../utils/computers/terminal-token.js";

// Route-level tests for GET /api/web/computers/terminal. Auth mirrors
// computer-upload.test.ts (RS256 tokens verified against a stubbed JWKS at
// `/computers/terminal-jwks`, plus a fetch stub for the control-plane
// `/computers/sandbox-info` lookup), but the transport under test here is the
// WS handshake itself: a real http.Server + a real `ws` client, since the
// token rides the Sec-WebSocket-Protocol header.

vi.mock("../../../utils/computers/attach-computer.js", () => ({
  attachComputerSandbox: vi.fn(),
}));

vi.mock("../../../utils/route-error-report.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/route-error-report.js")>()),
  reportRouteFailure: vi.fn(),
}));

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
  app.use("*", requestLogContextMiddleware);
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
    vi.mocked(reportRouteFailure).mockClear();
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
    expect(vi.mocked(attachComputerSandbox)).not.toHaveBeenCalled();
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
    expect(vi.mocked(attachComputerSandbox)).not.toHaveBeenCalled();
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
    vi.mocked(attachComputerSandbox).mockResolvedValue(fakeSandbox as never);

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

  it.each([
    "complete",
    "reject",
    "close",
    "byte overflow",
    "frame overflow",
    "byte capacity recovers",
    "frame capacity recovers",
  ] as const)(
    "keeps terminal stdin bounded and ordered: %s",
    async (outcome) => {
      stubConfiguredEnv();
      installSandboxInfoStub("sbx_42");
      let finish!: () => void;
      let fail!: (error: Error) => void;
      const firstWrite = new Promise<void>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
      const fakePty = { pid: 1, wait: () => new Promise(() => {}) };
      const fakeSandbox = {
        pty: {
          create: vi.fn().mockResolvedValue(fakePty),
          resize: vi.fn().mockResolvedValue(undefined),
          sendInput: vi
            .fn()
            .mockResolvedValue(undefined)
            .mockImplementationOnce(() => firstWrite),
          kill: vi.fn().mockResolvedValue(undefined),
        },
      };
      vi.mocked(attachComputerSandbox).mockResolvedValue(fakeSandbox as never);

      const token = await signToken();
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/api/web/computers/terminal?cols=80&rows=24`,
        [token]
      );
      await waitForMessage(ws); // "ready"

      try {
        if (outcome.includes("overflow") || outcome.includes("capacity")) {
          const byteLimit = 1024 * 1024;
          const frameLimit = 4096;
          const byteCase = outcome.startsWith("byte");
          const overflow = outcome.endsWith("overflow");
          const frames = byteCase
            ? [Buffer.alloc(byteLimit - (overflow ? 0 : 1)), Buffer.from("b")]
            : Array.from(
                { length: frameLimit + (overflow ? 1 : 0) },
                () => Buffer.from("a"),
              );
          const firstPong = waitForMessage(ws);
          ws.send(frames[0]);
          ws.send(JSON.stringify({ type: "ping" }));
          expect(await firstPong).toEqual({ type: "pong" });
          expect(fakeSandbox.pty.sendInput).toHaveBeenCalledTimes(1);
          const message = waitForMessage(ws);
          const closed = overflow ? waitForClose(ws) : undefined;
          for (const frame of frames.slice(1)) ws.send(frame);
          if (overflow) {
            await vi.waitFor(() => expect(ws.readyState).toBe(WebSocket.CLOSED));
            expect(await message).toEqual({
              type: "error",
              message: "Couldn't send input to the terminal. Reconnect to continue.",
            });
            expect((await closed)?.code).toBe(4503);
            expect(fakeSandbox.pty.sendInput.mock.calls[0][2]).toEqual({
              signal: expect.objectContaining({ aborted: true }),
            });
            expect(reportRouteFailure).toHaveBeenCalledTimes(1);
            finish();
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(fakeSandbox.pty.sendInput).toHaveBeenCalledTimes(1);
          } else {
            ws.send(JSON.stringify({ type: "ping" }));
            expect(await message).toEqual({ type: "pong" });
            expect(fakeSandbox.pty.sendInput).toHaveBeenCalledTimes(1);
            finish();
            await vi.waitFor(() =>
              expect(fakeSandbox.pty.sendInput).toHaveBeenCalledTimes(2),
            );
            expect(Buffer.concat(fakeSandbox.pty.sendInput.mock.calls.map(
              (call) => Buffer.from(call[1]),
            ))).toEqual(Buffer.concat(frames));
            // Acknowledged input releases capacity for subsequent frames.
            const pong = waitForMessage(ws);
            ws.send(Buffer.from("z"));
            ws.send(JSON.stringify({ type: "ping" }));
            expect(await pong).toEqual({ type: "pong" });
            await vi.waitFor(() =>
              expect(fakeSandbox.pty.sendInput).toHaveBeenCalledTimes(
                3,
              ),
            );
            expect(reportRouteFailure).not.toHaveBeenCalled();
          }
          return;
        }
        // A pong proves all earlier frames reached the route while write one
        // is unresolved. Later input, including Enter, must not overtake it.
        const pong = waitForMessage(ws);
        ws.send(Buffer.from("a"));
        ws.send(Buffer.from("b"));
        ws.send(Buffer.from("\r"));
        ws.send(JSON.stringify({ type: "ping" }));
        expect(await pong).toEqual({ type: "pong" });
        expect(fakeSandbox.pty.sendInput).toHaveBeenCalledTimes(1);

        const touchCalls = vi.mocked(fetch).mock.calls.filter(([url, init]) => {
          if (!String(url).includes("/computers/terminal-sessions")) return false;
          return JSON.parse(String(init?.body)).action === "touch";
        });
        expect(touchCalls).toHaveLength(1);

        if (outcome === "complete") {
          finish();
          await vi.waitFor(() =>
            expect(fakeSandbox.pty.sendInput).toHaveBeenCalledTimes(2),
          );
          expect(
            fakeSandbox.pty.sendInput.mock.calls.map((call) =>
              Buffer.from(call[1]).toString(),
            ),
          ).toEqual(["a", "b\r"]);
        } else if (outcome === "reject") {
          const error = waitForMessage(ws);
          const closed = waitForClose(ws);
          fail(new Error("provider input failed"));
          expect(await error).toEqual({
            type: "error",
            message: "Couldn't send input to the terminal. Reconnect to continue.",
          });
          expect((await closed).code).toBe(4503);
          expect(reportRouteFailure).toHaveBeenCalledExactlyOnceWith(
            "[computer-terminal] input failed",
            expect.any(Error),
            {
              source: "routes.web.computer-terminal.input",
              hop: "mcpjam_internal",
            },
          );
          expect(fakeSandbox.pty.sendInput).toHaveBeenCalledTimes(1);
        } else {
          const closed = waitForClose(ws);
          ws.close();
          await closed;
          await vi.waitFor(() =>
            expect(fakeSandbox.pty.kill).toHaveBeenCalledTimes(1),
          );
          finish();
          // Let promise continuations run after the in-flight write settles.
          await new Promise((resolve) => setTimeout(resolve, 0));
          expect(reportRouteFailure).not.toHaveBeenCalled();
          expect(fakeSandbox.pty.sendInput).toHaveBeenCalledTimes(1);
        }
      } finally {
        finish();
        if (ws.readyState !== WebSocket.CLOSED) {
          const closed = waitForClose(ws);
          ws.close();
          await closed;
        }
      }
    },
  );
});
