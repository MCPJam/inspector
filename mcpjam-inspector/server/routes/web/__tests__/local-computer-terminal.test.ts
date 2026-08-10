import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";

/**
 * Route-level tests for GET /api/web/computers/local-terminal — the only path
 * from a browser to an interactive shell on the user's own machine.
 *
 * The transport under test is the WS handshake itself (the nonce rides
 * `Sec-WebSocket-Protocol`), so these run a real http.Server with a real `ws`
 * client, following computer-terminal.test.ts's recipe. node-pty is replaced by
 * a fake module — the native addon isn't installable in CI, and a fake lets us
 * assert the wire protocol and the kill-on-close contract deterministically.
 *
 * NOTE on Origin: `startServer()` builds a BARE Hono app, so the global
 * `originValidationMiddleware` (which 403s a disallowed Origin pre-upgrade in
 * both production entrypoints) is NOT in play here. What these exercise is the
 * handler's own in-handler check — including the local tightening that an
 * ABSENT Origin is rejected, which the HTTP middleware deliberately allows.
 */

const scratch = mkdtempSync(join(tmpdir(), "mcpjam-local-terminal-ws-"));
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => scratch };
});

const consentState = vi.hoisted(() => ({
  fingerprint: "a".repeat(64) as string | null,
}));
vi.mock("../../../utils/computers/local-consent.js", () => ({
  getLocalConsentFingerprint: async () => consentState.fingerprint,
}));

import {
  createLocalComputerTerminalWsHandler,
  killLocalComputerTerminals,
  resetLocalTerminalShutdownForTests,
  resolveLocalShell,
  shutdownLocalComputerTerminals,
} from "../local-computer-terminal.js";
import {
  resetLocalPtyCachesForTests,
  setLocalPtyModuleForTests,
  type NodePtyModule,
  type NodePtyProcess,
} from "../../../utils/computers/local-pty.js";
import {
  issueLocalTerminalNonce,
  resetLocalTerminalNoncesForTests,
} from "../../../utils/computers/local-terminal-auth.js";

const ALLOWED_ORIGIN = "http://localhost:5173";

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface FakePtyRecord {
  proc: NodePtyProcess;
  writes: string[];
  resizes: Array<{ cols: number; rows: number }>;
  killed: boolean;
  emit: (data: string) => void;
  exit: () => void;
  spawnOptions: Record<string, unknown>;
  spawnFile: string;
}

const spawned: FakePtyRecord[] = [];

/** When set, the next spawn sweeps the live set from inside `spawn` itself. */
let killDuringNextSpawn = false;

function installFakePty(): void {
  const module: NodePtyModule = {
    spawn: (file, _args, options) => {
      if (killDuringNextSpawn) {
        killDuringNextSpawn = false;
        // Runs BEFORE `createPtyWithCwd` resolves, so the handle provably is not
        // in `livePtys` yet — the generation check is the only thing that can
        // still kill it.
        killLocalComputerTerminals();
      }
      const dataListeners: Array<(d: string) => void> = [];
      const exitListeners: Array<(e: { exitCode: number }) => void> = [];
      const record: FakePtyRecord = {
        writes: [],
        resizes: [],
        killed: false,
        spawnFile: file,
        spawnOptions: options as Record<string, unknown>,
        emit: (data) => dataListeners.forEach((l) => l(data)),
        exit: () => exitListeners.forEach((l) => l({ exitCode: 0 })),
        proc: {
          pid: 1234,
          onData: (listener) => {
            dataListeners.push(listener);
            return { dispose: () => {} };
          },
          onExit: (listener) => {
            exitListeners.push(listener as never);
            return { dispose: () => {} };
          },
          write: (data) => {
            record.writes.push(data);
          },
          resize: (cols, rows) => {
            record.resizes.push({ cols, rows });
          },
          kill: () => {
            record.killed = true;
          },
        },
      };
      spawned.push(record);
      return record.proc;
    },
  };
  setLocalPtyModuleForTests(module);
}

async function startServer(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const app = new Hono();
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
  app.get(
    "/api/web/computers/local-terminal",
    createLocalComputerTerminalWsHandler(upgradeWebSocket)
  );
  const server = http.createServer();
  injectWebSocket(server);
  server.on("request", (_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        // `server.close()` alone does NOT drop established sockets — the same
        // reason `shutdownLocalComputerTerminals()` has to exist.
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

const MINT_FINGERPRINT = "a".repeat(64);

/** Mint a nonce bound to the fingerprint the handler will see as live. */
function mintNonce(projectId = "proj_1", fingerprint = MINT_FINGERPRINT) {
  return issueLocalTerminalNonce(projectId, fingerprint);
}

function connect(
  port: number,
  nonce: string,
  opts: { origin?: string | null } = {}
): WebSocket {
  const origin = opts.origin === undefined ? ALLOWED_ORIGIN : opts.origin;
  return new WebSocket(
    `ws://127.0.0.1:${port}/api/web/computers/local-terminal?cols=100&rows=30`,
    [nonce],
    origin === null ? {} : { origin }
  );
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

function waitForJson(
  ws: WebSocket,
  type: string
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${type}`)),
      5_000
    );
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      try {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        if (message.type === type) {
          clearTimeout(timer);
          resolve(message);
        }
      } catch {
        // non-JSON text frame; ignore
      }
    });
  });
}

function waitForBinary(ws: WebSocket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for binary")),
      5_000
    );
    ws.on("message", (data, isBinary) => {
      if (!isBinary) return;
      clearTimeout(timer);
      resolve(data as Buffer);
    });
  });
}

let server: { port: number; close: () => Promise<void> };

beforeEach(async () => {
  vi.stubEnv("ALLOWED_ORIGINS", ALLOWED_ORIGIN);
  spawned.length = 0;
  killDuringNextSpawn = false;
  consentState.fingerprint = MINT_FINGERPRINT;
  resetLocalTerminalNoncesForTests();
  resetLocalPtyCachesForTests();
  resetLocalTerminalShutdownForTests();
  installFakePty();
  server = await startServer();
});

afterEach(async () => {
  await server.close();
  vi.unstubAllEnvs();
  resetLocalPtyCachesForTests();
  resetLocalTerminalNoncesForTests();
  resetLocalTerminalShutdownForTests();
});

describe("local terminal WS — auth", () => {
  it("opens a PTY for a valid nonce and announces ready", async () => {
    const { nonce } = mintNonce();
    const ws = connect(server.port, nonce);
    const ready = await waitForJson(ws, "ready");

    expect(typeof ready.sessionId).toBe("string");
    expect(spawned).toHaveLength(1);
    ws.close();
  });

  it("4401s an unknown nonce — and never spawns", async () => {
    const ws = connect(server.port, "not-a-real-nonce");
    const { code } = await waitForClose(ws);

    expect(code).toBe(4401);
    expect(spawned).toHaveLength(0);
  });

  it("4401s an EMPTY nonce", async () => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${server.port}/api/web/computers/local-terminal`,
      { origin: ALLOWED_ORIGIN }
    );
    const { code } = await waitForClose(ws);

    expect(code).toBe(4401);
    expect(spawned).toHaveLength(0);
  });

  it("4401s a REUSED nonce — single use survives a replayed handshake", async () => {
    const { nonce } = mintNonce();
    const first = connect(server.port, nonce);
    await waitForJson(first, "ready");
    first.close();

    const replay = connect(server.port, nonce);
    const { code } = await waitForClose(replay);

    expect(code).toBe(4401);
    expect(spawned).toHaveLength(1);
  });

  it("4401s a DISALLOWED Origin", async () => {
    const { nonce } = mintNonce();
    const ws = connect(server.port, nonce, {
      origin: "https://evil.example.com",
    });
    const { code } = await waitForClose(ws);

    expect(code).toBe(4401);
    expect(spawned).toHaveLength(0);
  });

  it("4401s an ABSENT Origin — the local tightening over the HTTP middleware", async () => {
    const { nonce } = mintNonce();
    const ws = connect(server.port, nonce, { origin: null });
    const { code } = await waitForClose(ws);

    expect(code).toBe(4401);
    expect(spawned).toHaveLength(0);
  });

  it("does NOT consume the nonce when the Origin is rejected", async () => {
    const { nonce } = mintNonce();
    const rejected = connect(server.port, nonce, { origin: null });
    await waitForClose(rejected);

    // The origin check runs first, so a blocked probe can't burn a legitimate
    // user's nonce out from under them.
    const ws = connect(server.port, nonce);
    await waitForJson(ws, "ready");
    expect(spawned).toHaveLength(1);
    ws.close();
  });
});

describe("local terminal WS — consent is re-checked at redeem", () => {
  it("4401s a nonce whose consent has been REVOKED inside the TTL", async () => {
    const { nonce } = mintNonce();
    // The user clicked "Forget & re-authorize" between mint and connect. The
    // 60s TTL must not outlive the capability that authorized it.
    consentState.fingerprint = null;

    const ws = connect(server.port, nonce);
    const { code } = await waitForClose(ws);

    expect(code).toBe(4401);
    expect(spawned).toHaveLength(0);
  });

  it("4401s a nonce whose consent was ROTATED by a re-grant", async () => {
    const { nonce } = mintNonce();
    // Another browser profile re-granted, rotating the capability.
    consentState.fingerprint = "b".repeat(64);

    const ws = connect(server.port, nonce);
    const { code } = await waitForClose(ws);

    expect(code).toBe(4401);
    expect(spawned).toHaveLength(0);
  });
});

describe("local terminal WS — shutdown", () => {
  it("kills a live PTY", async () => {
    const { nonce } = mintNonce();
    const ws = connect(server.port, nonce);
    await waitForJson(ws, "ready");

    shutdownLocalComputerTerminals();
    expect(spawned[0]!.killed).toBe(true);

    // The fake PTY's kill doesn't emit `exit`, so the socket is still open —
    // close it here rather than leaving it for the server teardown.
    ws.close();
    await waitForClose(ws);
  });

  it("kill-only does NOT latch — the server can come back", async () => {
    const first = mintNonce();
    const ws = connect(server.port, first.nonce);
    await waitForJson(ws, "ready");

    // Electron's `window-all-closed` path: the server goes away but the process
    // survives and restarts on dock activation. Latching here would 4503 every
    // handshake for the rest of the process lifetime.
    killLocalComputerTerminals();
    expect(spawned[0]!.killed).toBe(true);
    ws.close();
    await waitForClose(ws);

    const second = mintNonce();
    const reopened = connect(server.port, second.nonce);
    await waitForJson(reopened, "ready");
    expect(spawned).toHaveLength(2);
    reopened.close();
    await waitForClose(reopened);
  });

  it("kills a PTY whose spawn was in flight when the set was drained", async () => {
    killDuringNextSpawn = true;
    const { nonce } = mintNonce();
    const ws = connect(server.port, nonce);

    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    // The sweep happened mid-spawn, so this handle was never registered — only
    // the generation check can account for it being dead.
    await vi.waitFor(() => expect(spawned[0]!.killed).toBe(true));
    ws.close();
    await waitForClose(ws);
  });

  it("refuses NEW handshakes once shutdown has begun", async () => {
    const { nonce } = mintNonce();
    shutdownLocalComputerTerminals();

    const ws = connect(server.port, nonce);
    const { code } = await waitForClose(ws);

    // Otherwise a handshake landing during the shutdown window spawns a shell
    // that nothing will ever kill.
    expect(code).toBe(4503);
    expect(spawned).toHaveLength(0);
  });
});

describe("local terminal WS — degrade", () => {
  it("4503s with an explanatory message when node-pty can't load", async () => {
    setLocalPtyModuleForTests(null);
    const { nonce } = mintNonce();
    const ws = connect(server.port, nonce);
    const error = await waitForJson(ws, "error");
    const { code } = await waitForClose(ws);

    expect(code).toBe(4503);
    expect(String(error.message)).toMatch(/unavailable/i);
    expect(spawned).toHaveLength(0);
  });
});

describe("local terminal WS — wire protocol", () => {
  it("spawns in the project workspace dir with the allowlisted env", async () => {
    const { nonce } = mintNonce();
    const ws = connect(server.port, nonce);
    await waitForJson(ws, "ready");

    const options = spawned[0]!.spawnOptions;
    expect(String(options.cwd)).toBe(
      join(scratch, ".mcpjam", "computer", "proj_1")
    );
    const env = options.env as NodeJS.ProcessEnv;
    // The allowlist, not process.env: cloud credentials must never reach a PTY.
    expect(env).not.toHaveProperty("E2B_API_KEY");
    expect(env).not.toHaveProperty("INSPECTOR_SERVICE_TOKEN");
    expect(options.cols).toBe(100);
    expect(options.rows).toBe(30);
    ws.close();
  });

  it("streams PTY output to the client as binary frames", async () => {
    const { nonce } = mintNonce();
    const ws = connect(server.port, nonce);
    await waitForJson(ws, "ready");

    const received = waitForBinary(ws);
    spawned[0]!.emit("hello from the pty");

    expect((await received).toString("utf8")).toBe("hello from the pty");
    ws.close();
  });

  it("forwards binary client frames to PTY stdin", async () => {
    const { nonce } = mintNonce();
    const ws = connect(server.port, nonce);
    await waitForJson(ws, "ready");

    ws.send(Buffer.from("ls -la\n", "utf8"));
    await vi.waitFor(() => expect(spawned[0]!.writes).toContain("ls -la\n"));
    ws.close();
  });

  it("answers ping with pong", async () => {
    const { nonce } = mintNonce();
    const ws = connect(server.port, nonce);
    await waitForJson(ws, "ready");

    ws.send(JSON.stringify({ type: "ping" }));
    await waitForJson(ws, "pong");
    ws.close();
  });

  it("applies resize, CLAMPED to sane geometry", async () => {
    const { nonce } = mintNonce();
    const ws = connect(server.port, nonce);
    await waitForJson(ws, "ready");

    ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    ws.send(JSON.stringify({ type: "resize", cols: 99_999, rows: 99_999 }));
    ws.send(JSON.stringify({ type: "resize", cols: -5, rows: 0 }));

    await vi.waitFor(() => expect(spawned[0]!.resizes).toHaveLength(3));
    expect(spawned[0]!.resizes[0]).toEqual({ cols: 120, rows: 40 });
    expect(spawned[0]!.resizes[1]).toEqual({ cols: 500, rows: 300 });
    // Out-of-range low values fall back to the defaults rather than 0/negative.
    expect(spawned[0]!.resizes[2]).toEqual({ cols: 80, rows: 24 });
    ws.close();
  });

  it("ignores malformed text frames instead of dying", async () => {
    const { nonce } = mintNonce();
    const ws = connect(server.port, nonce);
    await waitForJson(ws, "ready");

    ws.send("{not json");
    ws.send(JSON.stringify({ type: "ping" }));
    await waitForJson(ws, "pong");
    ws.close();
  });
});

describe("local terminal WS — lifecycle", () => {
  it("KILLS the PTY when the socket closes (no orphaned shells)", async () => {
    const { nonce } = mintNonce();
    const ws = connect(server.port, nonce);
    await waitForJson(ws, "ready");
    expect(spawned[0]!.killed).toBe(false);

    ws.close();
    await vi.waitFor(() => expect(spawned[0]!.killed).toBe(true));
  });

  it("closes the socket cleanly when the PTY exits", async () => {
    const { nonce } = mintNonce();
    const ws = connect(server.port, nonce);
    await waitForJson(ws, "ready");

    const exited = waitForJson(ws, "exit");
    const closed = waitForClose(ws);
    spawned[0]!.exit();

    await exited;
    expect((await closed).code).toBe(1000);
  });
});

describe("resolveLocalShell", () => {
  it("prefers $SHELL when it exists", () => {
    const bash = resolveLocalShell({ PATH: process.env.PATH });
    // Use a shell we know is present on this host as the "preferred" value.
    expect(resolveLocalShell({ PATH: process.env.PATH, SHELL: bash })).toBe(
      bash
    );
  });

  it("falls back to bash when $SHELL is STALE rather than failing the open", () => {
    // node-pty spawns synchronously and would throw on a nonexistent shell,
    // surfacing as "failed to open a terminal" on a machine where bash exists.
    const resolved = resolveLocalShell({
      PATH: process.env.PATH,
      SHELL: "/nonexistent/shell",
    });
    expect(resolved).not.toBe("/nonexistent/shell");
    expect(resolved).toMatch(/bash|^sh$/);
  });

  it("falls back to a bare sh when nothing else resolves", () => {
    expect(resolveLocalShell({ PATH: "/nonexistent/bin" })).toMatch(
      /bash|^sh$/
    );
  });
});
