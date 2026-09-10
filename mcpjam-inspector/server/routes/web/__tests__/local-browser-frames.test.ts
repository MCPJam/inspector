import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
vi.mock("../../../utils/computers/browser-consent.js", () => ({
  getBrowserConsentFingerprint: async () => consentState.fingerprint,
  watchBrowserConsentChanges: () => () => {},
}));

const sessionState = vi.hoisted(() => ({
  /** What the viewport says it dropped, as the daemon's counters would. */
  counters: {
    framesIn: 0,
    framesOut: 0,
    bytesOut: 0,
    dropped: { dedupe: 0, oversize: 0, pacer: 0 },
  },
  /** bootId → the project that browser belongs to. */
  browsers: new Map<string, string>(),
  /** Frame listeners, so a test can push a frame or revoke a subscription. */
  subscriptions: [] as Array<{
    holder?: string;
    listener: (frame: unknown) => void;
    onRevoked?: (reason: string) => void;
    unsubscribed: boolean;
    revalidated: number;
  }>,
  touches: 0,
  refuse: null as string | null,
  revokeOnRevalidate: false,
  /** Input batches the route dispatched, in the order it dispatched them. */
  inputs: [] as Array<{ holder?: string; tabId?: string; events: unknown[] }>,
  refuseInput: null as string | null,
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
          const entry = { ...args, unsubscribed: false, revalidated: 0 };
          sessionState.subscriptions.push(entry);
          return {
            ok: true as const,
            unsubscribe: () => {
              entry.unsubscribed = true;
            },
            revalidate: () => {
              entry.revalidated += 1;
              if (sessionState.revokeOnRevalidate) {
                entry.onRevoked?.("lease_held");
              }
            },
            // The viewport's own drop accounting, which the relay folds into
            // the pane's `stats` message: in-process there is no heartbeat to
            // carry it, so this is the only way the local overlay ever shows a
            // dedupe, oversize or pacer drop.
            counters: () => sessionState.counters,
            noteTransportDrop: () => {
              sessionState.counters.dropped.pacer += 1;
            },
            stillCurrent: async () => true,
            subscriberCount: () => 1,
          };
        },
        async dispatchInput(args: {
          holder?: string;
          tabId?: string;
          events: unknown[];
        }) {
          sessionState.inputs.push(args);
          if (sessionState.refuseInput) {
            return { ok: false as const, error: sessionState.refuseInput };
          }
          return { ok: true as const };
        },
      },
    };
  },
  touchLocalBrowserSession: () => {
    sessionState.touches += 1;
  },
}));

import { createLocalBrowserFramesWsHandler } from "../local-browser-frames.js";
import {
  createFrameStreamDecoder,
  FRAME_STREAM_KIND,
} from "../../../services/browserd/frame-stream.js";
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
  args: {
    bootId: string;
    nonce: string;
    origin?: string | null;
    wire?: "binary";
  },
): WebSocket {
  const origin = args.origin === undefined ? ALLOWED_ORIGIN : args.origin;
  return new WebSocket(
    `ws://127.0.0.1:${port}${PATH}?bootId=${encodeURIComponent(
      args.bootId,
    )}&holder=rail-1${args.wire === "binary" ? "&wire=binary" : ""}`,
    [args.nonce],
    origin === null ? {} : { origin },
  );
}

function waitForClose(
  ws: WebSocket,
): Promise<{ code: number; reason: string }> {
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
  sessionState.revokeOnRevalidate = false;
  sessionState.inputs = [];
  sessionState.refuseInput = null;
  server = await startServer();
});

afterEach(async () => {
  await server.close();
  vi.unstubAllEnvs();
});

describe("the agent browser's frame socket", () => {
  it("streams frames to a caller whose nonce names this browser's project", async () => {
    const ws = connect(server.port, {
      bootId: "boot-a",
      nonce: mint("proj-a"),
    });
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

  it("stamps every frame with the hop the pane can measure against", async () => {
    const ws = connect(server.port, {
      bootId: "boot-a",
      nonce: mint("proj-a"),
    });
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));
    await vi.waitFor(() => expect(sessionState.subscriptions).toHaveLength(1));

    const received = new Promise<Record<string, never>>((resolve) => {
      ws.on("message", (data) => resolve(JSON.parse(String(data))));
    });
    sessionState.subscriptions[0]?.listener({ seq: 1, data: "Zm9v", ts: 1 });

    const message = (await received) as unknown as {
      frame: { relayTs: number; ts: number };
    };
    // Even on loopback, where it equals `ts`: the pane must not have to know
    // which engine drew a frame to know which field it may subtract from its
    // own clock.
    expect(message.frame.relayTs).toBeGreaterThan(0);
    ws.close();
  });

  it("echoes the pane's ping stamp", async () => {
    const ws = connect(server.port, {
      bootId: "boot-a",
      nonce: mint("proj-a"),
    });
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));
    await vi.waitFor(() => expect(sessionState.subscriptions).toHaveLength(1));

    const pong = new Promise<{ type: string; t?: number }>((resolve) => {
      ws.on("message", (data) => {
        const parsed = JSON.parse(String(data)) as { type: string; t?: number };
        if (parsed.type === "pong") resolve(parsed);
      });
    });
    ws.send(JSON.stringify({ type: "ping", t: 777 }));
    expect(await pong).toEqual({ type: "pong", t: 777 });
    ws.close();
  });

  it("refuses a nonce minted for a DIFFERENT project", async () => {
    // The nonce is the authorization and it names a project; the bootId is
    // supplied by the caller. Without comparing them, one project's pane opens
    // another project's persistent, signed-in profile.
    const ws = connect(server.port, {
      bootId: "boot-b",
      nonce: mint("proj-a"),
    });
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
    const ws = connect(server.port, {
      bootId: "boot-a",
      nonce: mint("proj-a"),
    });
    expect((await waitForClose(ws)).code).toBe(4404);
  });

  it("closes the socket when the daemon revokes the subscription mid-stream", async () => {
    // Somebody else took control while this pane was watching. Going quiet
    // would read as a broken stream; the pane can offer "wait for them to hand
    // it back" only if it is told what happened.
    const ws = connect(server.port, {
      bootId: "boot-a",
      nonce: mint("proj-a"),
    });
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));
    await vi.waitFor(() => expect(sessionState.subscriptions).toHaveLength(1));

    const closed = waitForClose(ws);
    sessionState.subscriptions[0]?.onRevoked?.("lease_held");

    // 4409, NOT the 4401 the auth failures use: this one passes when they hand
    // back, and the pane has to be able to tell the difference to reconnect.
    expect((await closed).code).toBe(4409);
    expect(sessionState.subscriptions[0]?.unsubscribed).toBe(true);
  });

  it("unsubscribes when the client hangs up", async () => {
    // A viewport listener left attached to a dead socket keeps the screencast
    // running for nobody.
    const ws = connect(server.port, {
      bootId: "boot-a",
      nonce: mint("proj-a"),
    });
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));
    await vi.waitFor(() => expect(sessionState.subscriptions).toHaveLength(1));

    ws.close();
    await vi.waitFor(() =>
      expect(sessionState.subscriptions[0]?.unsubscribed).toBe(true),
    );
  });

  it("passes the daemon's refusal through when the lease is held elsewhere", async () => {
    sessionState.refuse = "lease_held";
    const ws = connect(server.port, {
      bootId: "boot-a",
      nonce: mint("proj-a"),
    });

    const closed = await waitForClose(ws);
    expect(closed.code).toBe(4409);
    expect(closed.reason).toBe("lease_held");
  });

  it("tells a lease refusal apart from every auth failure", async () => {
    // They used to share 4401, so the pane had one response for both. It chose
    // "somebody took control", which reported a consent change as a handoff
    // and — since it retried on a timer — kept saying so forever.
    sessionState.refuse = "lease_held";
    const refused = await waitForClose(
      connect(server.port, { bootId: "boot-a", nonce: mint("proj-a") }),
    );
    sessionState.refuse = null;

    consentState.fingerprint = "b".repeat(64);
    const unauthorized = await waitForClose(
      connect(server.port, { bootId: "boot-a", nonce: mint("proj-a") }),
    );

    expect(refused.code).toBe(4409);
    expect(unauthorized.code).toBe(4401);
    expect(refused.code).not.toBe(unauthorized.code);
  });

  it("closes 4404, not a lease refusal, for a tab that does not exist", async () => {
    sessionState.refuse = "unknown_tab";
    const closed = await waitForClose(
      connect(server.port, { bootId: "boot-a", nonce: mint("proj-a") }),
    );
    expect(closed.code).toBe(4404);
  });
});

describe("the agent browser's frame socket — losing the right to watch", () => {
  it("closes a watcher whose lease moved even when the page paints nothing", async () => {
    // Revocation rides frame delivery, and a STATIC page delivers none — so
    // without this the pane sits on a frozen picture, unable to tell "somebody
    // took control" apart from "the page is quiet".
    const ws = connect(server.port, {
      bootId: "boot-a",
      nonce: mint("proj-a"),
    });
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));
    await vi.waitFor(() => expect(sessionState.subscriptions).toHaveLength(1));

    sessionState.revokeOnRevalidate = true;
    const closed = waitForClose(ws);
    ws.send(JSON.stringify({ type: "ping" }));

    expect((await closed).code).toBe(4409);
    expect(sessionState.subscriptions[0]?.revalidated).toBeGreaterThan(0);
  });

  it("re-asks on every heartbeat while the lease is still theirs", async () => {
    const ws = connect(server.port, {
      bootId: "boot-a",
      nonce: mint("proj-a"),
    });
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));
    await vi.waitFor(() => expect(sessionState.subscriptions).toHaveLength(1));

    const pong = new Promise<void>((resolve) => {
      ws.on("message", (data) => {
        if (JSON.parse(String(data)).type === "pong") resolve();
      });
    });
    ws.send(JSON.stringify({ type: "ping" }));
    await pong;

    expect(sessionState.subscriptions[0]?.revalidated).toBe(1);
    expect(sessionState.subscriptions[0]?.unsubscribed).toBe(false);
    ws.close();
  });
});

describe("input on the frame socket", () => {
  /** Open a socket and wait until it is subscribed. */
  async function open() {
    const ws = connect(server.port, {
      bootId: "boot-a",
      nonce: mint("proj-a"),
    });
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));
    await vi.waitFor(() => expect(sessionState.subscriptions).toHaveLength(1));
    return ws;
  }

  function collect(ws: WebSocket): Array<Record<string, unknown>> {
    const seen: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => seen.push(JSON.parse(String(data))));
    return seen;
  }

  it("says it can take input before the pane has to guess", async () => {
    const ws = connect(server.port, {
      bootId: "boot-a",
      nonce: mint("proj-a"),
    });
    const hello = new Promise<Record<string, unknown>>((resolve) => {
      ws.on("message", (data) => {
        const parsed = JSON.parse(String(data)) as Record<string, unknown>;
        if (parsed.type === "hello") resolve(parsed);
      });
    });
    expect(await hello).toMatchObject({
      type: "hello",
      features: ["input"],
      codecs: ["jpeg"],
      // A pane that asked for nothing gets the envelope it always had.
      wire: "json",
    });
    ws.close();
  });

  it("dispatches with the holder the SOCKET was opened with", async () => {
    const ws = await open();
    const seen = collect(ws);
    ws.send(
      JSON.stringify({
        type: "input",
        seq: 5,
        // Ignored: the holder comes from the socket's own query, which the
        // nonce authorized, not from a field anyone can put in a message.
        holder: "rail-someone-else",
        events: [{ type: "mouse_move", x: 7, y: 8 }],
      }),
    );
    await vi.waitFor(() => expect(sessionState.inputs).toHaveLength(1));
    expect(sessionState.inputs[0]).toMatchObject({
      holder: "rail-1",
      events: [{ type: "mouse_move", x: 7, y: 8 }],
    });
    await vi.waitFor(() =>
      expect(seen.some((m) => m.type === "input_ack")).toBe(true),
    );
    expect(seen.find((m) => m.type === "input_ack")).toEqual({
      type: "input_ack",
      seq: 5,
      dispatched: 1,
    });
    ws.close();
  });

  it("answers a lease refusal with an ack and stays open", async () => {
    sessionState.refuseInput = "lease_held";
    const ws = await open();
    const seen = collect(ws);
    ws.send(
      JSON.stringify({
        type: "input",
        seq: 2,
        events: [{ type: "text", text: "hi" }],
      }),
    );
    await vi.waitFor(() =>
      expect(seen.some((m) => m.type === "input_ack")).toBe(true),
    );
    expect(seen.find((m) => m.type === "input_ack")).toEqual({
      type: "input_ack",
      seq: 2,
      dispatched: 0,
      refused: "lease_held",
    });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("refuses a malformed batch whole", async () => {
    const ws = await open();
    const seen = collect(ws);
    ws.send(
      JSON.stringify({
        type: "input",
        seq: 3,
        events: [
          { type: "mouse_down", x: 1, y: 1, button: "left" },
          { type: "?" },
        ],
      }),
    );
    await vi.waitFor(() =>
      expect(seen.some((m) => m.type === "input_ack")).toBe(true),
    );
    expect(seen.find((m) => m.type === "input_ack")).toMatchObject({
      refused: "invalid_input",
    });
    expect(sessionState.inputs).toHaveLength(0);
    ws.close();
  });
});

/**
 * V-4b. The local pane reads the same wire the hosted one does — not because
 * loopback needs the bytes, but because one decoder exercised on every local
 * session is one decoder that cannot rot until staging finds it.
 */
describe("the binary wire", () => {
  it("encodes the frame with the daemon's own header", async () => {
    const ws = connect(server.port, {
      bootId: "boot-a",
      nonce: mint("proj-a"),
      wire: "binary",
    });
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));
    await vi.waitFor(() => expect(sessionState.subscriptions).toHaveLength(1));

    const record = new Promise<Buffer>((resolve) => {
      ws.on("message", (data, isBinary) => {
        if (isBinary) resolve(data as Buffer);
      });
    });
    const before = Date.now();
    sessionState.subscriptions[0]?.listener({
      data: Buffer.from("hello").toString("base64"),
      deviceWidth: 1024,
      deviceHeight: 768,
      scale: 1,
      ts: 1,
      seq: 4,
    });

    const bytes = await record;
    const decoded = createFrameStreamDecoder().push(new Uint8Array(bytes));
    expect(decoded.ok).toBe(true);
    const frame = decoded.ok ? decoded.records[0] : undefined;
    expect(frame).toMatchObject({
      kind: FRAME_STREAM_KIND.frame,
      deviceWidth: 1024,
      deviceHeight: 768,
      seq: 4,
    });
    expect((frame as { ts: number }).ts).toBeGreaterThanOrEqual(before);
    expect(Buffer.from((frame as { jpeg: Uint8Array }).jpeg).toString()).toBe(
      "hello",
    );
    ws.close();
  });

  it("keeps JSON for a pane that did not ask", async () => {
    const ws = connect(server.port, {
      bootId: "boot-a",
      nonce: mint("proj-a"),
    });
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));
    await vi.waitFor(() => expect(sessionState.subscriptions).toHaveLength(1));

    const message = new Promise<Record<string, never>>((resolve) => {
      ws.on("message", (data, isBinary) => {
        if (isBinary) throw new Error("a pane that did not ask got bytes");
        const parsed = JSON.parse(String(data));
        if (parsed.type === "frame") resolve(parsed);
      });
    });
    sessionState.subscriptions[0]?.listener({ seq: 1, data: "Zm9v", ts: 1 });
    expect(await message).toMatchObject({ type: "frame" });
    ws.close();
  });

  it("says which wire it agreed to", async () => {
    const ws = connect(server.port, {
      bootId: "boot-a",
      nonce: mint("proj-a"),
      wire: "binary",
    });
    const hello = new Promise<Record<string, unknown>>((resolve) => {
      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        const parsed = JSON.parse(String(data)) as Record<string, unknown>;
        if (parsed.type === "hello") resolve(parsed);
      });
    });
    expect(await hello).toMatchObject({ wire: "binary" });
    ws.close();
  });
});

it.each([null, "replacement-grant"])(
  "terminates a silent established viewer when consent becomes %s",
  async (next) => {
    const ws = connect(server.port, {
      bootId: "boot-a",
      nonce: mint("proj-a"),
    });
    await new Promise<void>((resolve) => ws.once("open", resolve));
    await vi.waitFor(() => expect(sessionState.subscriptions).toHaveLength(1));
    const closed = waitForClose(ws);
    consentState.fingerprint = next;
    expect((await closed).code).toBe(4401);
    expect(sessionState.subscriptions[0].unsubscribed).toBe(true);
    expect(sessionState.inputs).toEqual([]);
  },
);
