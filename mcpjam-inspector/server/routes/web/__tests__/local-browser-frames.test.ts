import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";

/**
 * Route-level tests for the agent browser's frame socket.
 *
 * Two things it has to get right, and neither can be checked below the
 * transport. The HANDSHAKE: a single-use nonce in `Sec-WebSocket-Protocol`, an
 * Origin that must be present and allowed, and a consent capability that must
 * still be the live one. And the BINDING: the nonce names a project, the query
 * names a browser by `bootId`, and the caller supplies the second — so the two
 * have to be checked against each other or a nonce for one project opens
 * another project's signed-in browser.
 *
 * A real `http.Server` and a real `ws` client, following
 * `local-computer-terminal.test.ts`'s recipe. As there, `startServer()` builds
 * a BARE Hono app, so what these exercise is the handler's own Origin check —
 * including the local tightening that an ABSENT Origin is refused.
 */

const consentState = vi.hoisted(() => ({
  fingerprint: "a".repeat(64) as string | null,
}));
vi.mock("../../../utils/computers/local-consent.js", () => ({
  getLocalConsentFingerprint: async () => consentState.fingerprint,
}));

const sessionState = vi.hoisted(() => ({
  /** bootId → the project that browser belongs to. */
  browsers: new Map<string, string>(),
  /** Frame listeners, so a test can push a frame or revoke a subscription. */
  subscriptions: [] as Array<{
    holder?: string;
    listener: (frame: unknown) => void;
    onRevoked?: (reason: string) => void;
    unsubscribed: boolean;
  }>,
  touches: 0,
  refuse: null as string | null,
}));

vi.mock("../../../services/browserd/local/local-browser-session.js", () => ({
  findLocalBrowserSession: (bootId: string) => {
    const projectKey = sessionState.browsers.get(bootId);
    if (!projectKey) return undefined;
    return {
      projectKey,
      handle: { bootId },
      client: {},
      handler: {
        async subscribeFrames(args: {
          holder?: string;
          listener: (frame: unknown) => void;
          onRevoked?: (reason: string) => void;
        }) {
          if (sessionState.refuse) {
            return { ok: false as const, error: sessionState.refuse };
          }
          const entry = { ...args, unsubscribed: false };
          sessionState.subscriptions.push(entry);
          return {
            ok: true as const,
            unsubscribe: () => {
              entry.unsubscribed = true;
            },
          };
        },
      },
    };
  },
  touchLocalBrowserSession: () => {
    sessionState.touches += 1;
  },
}));

import { createLocalBrowserFramesWsHandler } from "../local-browser-frames.js";
import { issueLocalNonce } from "../../../utils/computers/local-terminal-auth.js";
import { resetLocalTerminalNoncesForTests } from "../../../utils/computers/local-terminal-auth.js";

const ALLOWED_ORIGIN = "http://localhost:5173";
const FINGERPRINT = "a".repeat(64);
const PATH = "/api/web/computers/local-browser/frames";

async function startServer(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const app = new Hono();
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
  app.get(PATH, createLocalBrowserFramesWsHandler(upgradeWebSocket));
  const server = http.createServer();
  injectWebSocket(server);
  server.on("request", (_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function mint(projectId: string) {
  return issueLocalNonce({
    kind: "browser-frames",
    projectId,
    consentFingerprint: FINGERPRINT,
  }).nonce;
}

function connect(
  port: number,
  args: { bootId: string; nonce: string; origin?: string | null },
): WebSocket {
  const origin = args.origin === undefined ? ALLOWED_ORIGIN : args.origin;
  return new WebSocket(
    `ws://127.0.0.1:${port}${PATH}?bootId=${encodeURIComponent(args.bootId)}&holder=rail-1`,
    [args.nonce],
    origin === null ? {} : { origin },
  );
}

function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.on("close", (code, reason) =>
      resolve({ code, reason: reason.toString() }),
    );
  });
}

let server: { port: number; close: () => Promise<void> };

beforeEach(async () => {
  vi.stubEnv("ALLOWED_ORIGINS", ALLOWED_ORIGIN);
  resetLocalTerminalNoncesForTests();
  consentState.fingerprint = FINGERPRINT;
  sessionState.browsers = new Map([
    ["boot-a", "proj-a"],
    ["boot-b", "proj-b"],
  ]);
  sessionState.subscriptions = [];
  sessionState.touches = 0;
  sessionState.refuse = null;
  server = await startServer();
});

afterEach(async () => {
  await server.close();
  vi.unstubAllEnvs();
});

describe("the agent browser's frame socket", () => {
  it("streams frames to a caller whose nonce names this browser's project", async () => {
    const ws = connect(server.port, { bootId: "boot-a", nonce: mint("proj-a") });
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));
    await vi.waitFor(() => expect(sessionState.subscriptions).toHaveLength(1));

    const received = new Promise<Record<string, unknown>>((resolve) => {
      ws.on("message", (data) => resolve(JSON.parse(String(data))));
    });
    sessionState.subscriptions[0]?.listener({ seq: 1, data: "Zm9v" });

    expect(await received).toMatchObject({ type: "frame" });
    // Watching IS using it: a person with the pane open must not have the
    // browser reaped out from under them.
    expect(sessionState.touches).toBeGreaterThan(0);
    ws.close();
  });

  it("refuses a nonce minted for a DIFFERENT project", async () => {
    // The nonce is the authorization and it names a project; the bootId is
    // supplied by the caller. Without comparing them, one project's pane opens
    // another project's persistent, signed-in profile.
    const ws = connect(server.port, { bootId: "boot-b", nonce: mint("proj-a") });
    const closed = await waitForClose(ws);

    expect(closed.code).toBe(4401);
    expect(closed.reason).toMatch(/another project/i);
    expect(sessionState.subscriptions).toHaveLength(0);
  });

  it("refuses a nonce that was already spent", async () => {
    const nonce = mint("proj-a");
    const first = connect(server.port, { bootId: "boot-a", nonce });
    await new Promise<void>((resolve) => first.on("open", () => resolve()));
    const second = connect(server.port, { bootId: "boot-a", nonce });

    expect((await waitForClose(second)).code).toBe(4401);
    first.close();
  });

  it("refuses a handshake with no Origin at all", async () => {
    const ws = connect(server.port, {
      bootId: "boot-a",
      nonce: mint("proj-a"),
      origin: null,
    });
    expect((await waitForClose(ws)).code).toBe(4401);
  });

  it("refuses when consent has been re-granted since the nonce was minted", async () => {
    const nonce = mint("proj-a");
    consentState.fingerprint = "b".repeat(64);
    const ws = connect(server.port, { bootId: "boot-a", nonce });

    const closed = await waitForClose(ws);
    expect(closed.code).toBe(4401);
    expect(closed.reason).toMatch(/consent/i);
  });

  it("closes 4404 for a browser that is no longer running", async () => {
    sessionState.browsers.delete("boot-a");
    const ws = connect(server.port, { bootId: "boot-a", nonce: mint("proj-a") });
    expect((await waitForClose(ws)).code).toBe(4404);
  });

  it("closes the socket when the daemon revokes the subscription mid-stream", async () => {
    // Somebody else took control while this pane was watching. Going quiet
    // would read as a broken stream; the pane can offer "wait for them to hand
    // it back" only if it is told what happened.
    const ws = connect(server.port, { bootId: "boot-a", nonce: mint("proj-a") });
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));
    await vi.waitFor(() => expect(sessionState.subscriptions).toHaveLength(1));

    const closed = waitForClose(ws);
    sessionState.subscriptions[0]?.onRevoked?.("lease_held");

    expect((await closed).code).toBe(4401);
    expect(sessionState.subscriptions[0]?.unsubscribed).toBe(true);
  });

  it("unsubscribes when the client hangs up", async () => {
    // A viewport listener left attached to a dead socket keeps the screencast
    // running for nobody.
    const ws = connect(server.port, { bootId: "boot-a", nonce: mint("proj-a") });
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));
    await vi.waitFor(() => expect(sessionState.subscriptions).toHaveLength(1));

    ws.close();
    await vi.waitFor(() =>
      expect(sessionState.subscriptions[0]?.unsubscribed).toBe(true),
    );
  });

  it("passes the daemon's refusal through when the lease is held elsewhere", async () => {
    sessionState.refuse = "lease_held";
    const ws = connect(server.port, { bootId: "boot-a", nonce: mint("proj-a") });

    const closed = await waitForClose(ws);
    expect(closed.code).toBe(4401);
    expect(closed.reason).toBe("lease_held");
  });
});
