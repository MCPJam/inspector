/**
 * Route-level tests for GET /api/web/webmcp/sessions/:id/frames — the binary
 * transport that carries painted frames off the SSE stream.
 *
 * What is under test IS the handshake and the wire, so these run a real
 * `http.Server` with `createNodeWebSocket` and a real `ws` client, following
 * local-computer-terminal.test.ts's recipe. The browser is a `FakeProvider`,
 * so frames are injected by calling the runtime's own `onFrame` callback —
 * exactly the path a screencast takes.
 *
 * The PACING contract is asserted against `createFramePacer` directly rather
 * than through a socket: it is defined in terms of when the send callback
 * fires, and a real kernel socket drains whenever it likes. The unit is where
 * "at most one send outstanding" is actually provable; the socket tests below
 * cover the wiring around it.
 *
 * NOTE on Origin: `startServer()` builds a BARE Hono app, so the global
 * `originValidationMiddleware` is not in play. What these exercise is the
 * handler's own check — including the tightening that an ABSENT Origin is
 * rejected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";

const configState = vi.hoisted(() => ({ enabled: true }));
vi.mock("../../../config.js", () => ({
  get WEBMCP_INSPECTOR_ENABLED() {
    return configState.enabled;
  },
  HOSTED_MODE: false,
}));

import {
  createFramePacer,
  createWebMcpFramesWsHandler,
  isFramePingMessage,
  toCallbackSocket,
  killWebMcpFrameSockets,
  resetWebMcpFramesForTests,
  shutdownWebMcpFrameSockets,
} from "../webmcp-frames.js";
import { generateSessionToken } from "../../../services/session-token.js";
import {
  startWebMcpSession,
  webMcpSessions,
} from "../../../services/webmcp-inspector/session-registry.js";
import {
  FakeProvider,
  fakeTool,
} from "../../../services/webmcp-inspector/__tests__/fake-provider.js";
import { decodeWebMcpBinaryFrame } from "@/shared/webmcp-inspector-protocol";

const ALLOWED_ORIGIN = "http://localhost:5173";

async function startServer(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const app = new Hono();
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
  app.get(
    "/api/web/webmcp/sessions/:id/frames",
    createWebMcpFramesWsHandler(upgradeWebSocket),
  );
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

/**
 * A client socket with its listeners attached from the moment it is created.
 *
 * Eagerly, and that matters: the replay frame can ride the same TCP segment as
 * the handshake response, so `ws` emits `message` in the same tick as `open`.
 * A test that attached its listener after awaiting `open` would miss exactly
 * the frame the replay contract is about.
 */
interface Probe {
  ws: WebSocket;
  opened: Promise<void>;
  closed: Promise<{ code: number; reason: string }>;
  binary: Buffer[];
  text: string[];
  /** Resolve once at least `count` binary messages have arrived. */
  waitForBinary(count?: number): Promise<Buffer>;
  /** Let anything in flight land. */
  settle(ms?: number): Promise<void>;
}

const probes: Probe[] = [];

function connect(
  port: number,
  sessionId: string,
  token: string | null,
  opts: { origin?: string | null } = {},
): Probe {
  const origin = opts.origin === undefined ? ALLOWED_ORIGIN : opts.origin;
  const url = `ws://127.0.0.1:${port}/api/web/webmcp/sessions/${sessionId}/frames`;
  const options = origin === null ? {} : { origin };
  const ws =
    token === null
      ? new WebSocket(url, options)
      : new WebSocket(url, [token], options);

  const binary: Buffer[] = [];
  const text: string[] = [];
  let notify: (() => void) | undefined;
  ws.on("error", () => {
    /* a rejected handshake still emits close, which is what tests read */
  });
  ws.on("message", (data, isBinary) => {
    if (isBinary) binary.push(data as Buffer);
    else text.push(data.toString());
    notify?.();
  });

  const probe: Probe = {
    ws,
    binary,
    text,
    opened: new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out opening")),
        5_000,
      );
      ws.on("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.on("close", (code) => {
        clearTimeout(timer);
        reject(new Error(`closed ${code} before opening`));
      });
    }),
    closed: new Promise((resolve) => {
      ws.on("close", (code, reason) =>
        resolve({ code, reason: reason.toString() }),
      );
    }),
    waitForBinary: (count = 1) =>
      new Promise<Buffer>((resolve, reject) => {
        const check = () => {
          if (binary.length < count) return;
          clearTimeout(timer);
          notify = undefined;
          resolve(binary[count - 1]!);
        };
        const timer = setTimeout(
          () => reject(new Error("timed out waiting for a binary frame")),
          5_000,
        );
        notify = check;
        check();
      }),
    settle: (ms = 120) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };
  probes.push(probe);
  return probe;
}

/** A JPEG-ish payload with recognisable bytes. */
function jpegBase64(byte: number): string {
  return Buffer.from([0xff, 0xd8, byte, byte, byte]).toString("base64");
}

let server: { port: number; close: () => Promise<void> };
let provider: FakeProvider;
let token: string;

beforeEach(async () => {
  vi.stubEnv("ALLOWED_ORIGINS", ALLOWED_ORIGIN);
  configState.enabled = true;
  resetWebMcpFramesForTests();
  await webMcpSessions.disposeAll();
  token = generateSessionToken();
  provider = new FakeProvider();
  server = await startServer();
});

afterEach(async () => {
  // Closed before the server: an established WS keeps `server.close()` waiting
  // forever, which is the same fact `shutdownWebMcpFrameSockets` exists for.
  for (const probe of probes) {
    try {
      probe.ws.terminate();
    } catch {
      /* already gone */
    }
  }
  probes.length = 0;
  await server.close();
  await webMcpSessions.disposeAll();
  resetWebMcpFramesForTests();
  vi.unstubAllEnvs();
});

async function openSession() {
  return startWebMcpSession({
    url: "https://example.test/",
    provider,
    registry: webMcpSessions,
  });
}

describe("webmcp frames WS — handshake", () => {
  it("opens for a valid token", async () => {
    const session = await openSession();
    await expect(
      connect(server.port, session.sessionId, token).opened,
    ).resolves.toBeUndefined();
  });

  it("rejects an absent or wrong subprotocol token with 4401", async () => {
    const session = await openSession();

    const wrong = connect(server.port, session.sessionId, "not-the-token");
    expect((await wrong.closed).code).toBe(4401);

    // `ws` refuses an empty protocol entry, so "no token" means no
    // `Sec-WebSocket-Protocol` header at all.
    const bare = connect(server.port, session.sessionId, null);
    expect((await bare.closed).code).toBe(4401);
  });

  it("rejects an absent Origin with 4401", async () => {
    // Browsers always send one on a handshake; a client without one has no
    // business opening this. The HTTP middleware deliberately allows an absent
    // Origin, which is why this check lives in the handler.
    const session = await openSession();
    const ws = connect(server.port, session.sessionId, token, { origin: null });
    expect((await ws.closed).code).toBe(4401);
  });

  it("rejects a disallowed Origin with 4401", async () => {
    const session = await openSession();
    const ws = connect(server.port, session.sessionId, token, {
      origin: "https://evil.test",
    });
    expect((await ws.closed).code).toBe(4401);
  });

  it("refuses with 4503 while the inspector is disabled", async () => {
    const session = await openSession();
    configState.enabled = false;
    const ws = connect(server.port, session.sessionId, token);
    expect((await ws.closed).code).toBe(4503);
  });

  it("refuses an unknown session with 4404", async () => {
    const ws = connect(server.port, "no-such-session", token);
    expect((await ws.closed).code).toBe(4404);
  });
});

describe("webmcp frames WS — the stream", () => {
  it("sends one binary message per frame, decoding to the published frame", async () => {
    const session = await openSession();
    const ws = connect(server.port, session.sessionId, token);
    await ws.opened;

    provider.sessions[0].emitFrame({
      data: jpegBase64(0x41),
      deviceWidth: 1024,
      deviceHeight: 640,
      ts: 1_700_000_000_500,
    });

    const decoded = decodeWebMcpBinaryFrame(await ws.waitForBinary());
    expect(decoded).toBeDefined();
    expect(decoded!.deviceWidth).toBe(1024);
    expect(decoded!.deviceHeight).toBe(640);
    expect(decoded!.ts).toBe(1_700_000_000_500);
    // The session's own counter, shared with the SSE stream — which is what
    // lets the client drop a straggling SSE frame that predates this one.
    expect(decoded!.seq).toBeGreaterThan(0);
    expect([...decoded!.jpeg]).toEqual([0xff, 0xd8, 0x41, 0x41, 0x41]);
    // ONE message per frame, not a meta/payload pair: a receiver that lost
    // track of which half it held would paint one frame's pixels with
    // another's dimensions.
    expect(ws.binary).toHaveLength(1);
    expect(ws.text).toHaveLength(0);
  });

  it("carries the capture scale, and reads an absent one as 1", async () => {
    const session = await openSession();
    const ws = connect(server.port, session.sessionId, token);
    await ws.opened;

    provider.sessions[0].emitFrame({
      data: jpegBase64(0x43),
      deviceWidth: 2560,
      deviceHeight: 1600,
      scale: 2,
    });
    const scaled = decodeWebMcpBinaryFrame(await ws.waitForBinary());
    // Dropped here, a 2560-wide frame would arrive claiming to be its own CSS
    // size and the client would send back every click at double coordinates.
    expect(scaled!.scale).toBe(2);
    expect(scaled!.deviceWidth).toBe(2560);

    provider.sessions[0].emitFrame({ data: jpegBase64(0x44) });
    const plain = decodeWebMcpBinaryFrame(await ws.waitForBinary(2));
    // A provider that has no notion of scale — the electron surface, an older
    // one — publishes frames without it, and 1 is what those have always meant.
    expect(plain!.scale).toBe(1);
  });

  it("tells the session when this socket cannot keep up", async () => {
    const session = await openSession();
    const ws = connect(server.port, session.sessionId, token);
    await ws.opened;
    const browser = provider.sessions[0];

    // Stop READING on the client. Writes keep succeeding until the kernel
    // buffers fill, so this needs real frames and enough of them — which is
    // also what makes it the honest version of this test: the pacer's own
    // contract is asserted as a unit above, and what is under test HERE is
    // that a socket the OS has stopped taking bytes from reaches the session.
    ws.ws.pause();
    const big = Buffer.alloc(200_000, 0x41).toString("base64");
    for (let i = 0; i < 60 && browser.pressureEvents === 0; i += 1) {
      browser.emitFrame({ data: big, ts: 1_000 + i });
      await ws.settle(10);
    }

    expect(browser.pressureEvents).toBeGreaterThan(0);
    ws.ws.resume();
  });

  it("replays the current paint to a socket that connects after it", async () => {
    const session = await openSession();
    // Published BEFORE anyone is listening: the hub holds exactly one frame,
    // and a connecting pane must paint from it rather than sit blank until the
    // page happens to repaint — which for a settled page is never.
    provider.sessions[0].emitFrame({ data: jpegBase64(0x42) });

    const ws = connect(server.port, session.sessionId, token);
    const decoded = decodeWebMcpBinaryFrame(await ws.waitForBinary());
    expect([...decoded!.jpeg]).toEqual([0xff, 0xd8, 0x42, 0x42, 0x42]);
  });

  it("carries frames only — no activity, tools or session chatter", async () => {
    const session = await openSession();
    const ws = connect(server.port, session.sessionId, token);
    await ws.opened;

    provider.sessions[0].emitTools([
      fakeTool({ origin: "https://example.test" }),
    ]);
    provider.sessions[0].callbacks.onNavigated(
      "https://example.test/two",
      "https://example.test",
    );
    await ws.settle();

    expect(ws.binary).toHaveLength(0);
    // Not even as text: this socket exists to carry pixels, and everything
    // else already has a stream that replays properly.
    expect(ws.text).toHaveLength(0);
  });

  it("answers a ping with a pong", async () => {
    const session = await openSession();
    const ws = connect(server.port, session.sessionId, token);
    await ws.opened;
    ws.ws.send(JSON.stringify({ type: "ping" }));
    await ws.settle();
    expect(ws.text).toContain(JSON.stringify({ type: "pong" }));
  });

  it("survives a control message that is not an object", async () => {
    const session = await openSession();
    const ws = connect(server.port, session.sessionId, token);
    await ws.opened;

    // The contract, end to end: a malformed control message is ignored and the
    // socket keeps serving. The parsing rule that makes this true by
    // construction — rather than by an adapter absorbing a TypeError — is
    // pinned directly in "ping message parsing" below.
    for (const payload of ["null", '"ping"', "42", "true", "[]", "[1,2]"]) {
      ws.ws.send(payload);
    }
    await ws.settle();
    expect(ws.text).toEqual([]);

    // …and the socket is still alive and still speaking the protocol.
    ws.ws.send(JSON.stringify({ type: "ping" }));
    await ws.settle();
    expect(ws.text).toEqual([JSON.stringify({ type: "pong" })]);
  });

  it("refreshes the session's idle deadline on a ping", async () => {
    const session = await openSession();
    const runtime = webMcpSessions.get(session.sessionId);
    const ws = connect(server.port, session.sessionId, token);
    await ws.opened;

    // Wind the deadline back to just short of expiry, as ten quiet minutes
    // would. A pane with no navigation, no invocation and nothing else
    // touching the registry is otherwise reaped out from under someone
    // looking straight at it.
    runtime.expiresAt = Date.now() + 1_000;
    const before = runtime.expiresAt;

    ws.ws.send(JSON.stringify({ type: "ping" }));
    await ws.settle();
    expect(runtime.expiresAt).toBeGreaterThan(before);
  });

  it("closes 4404 when the session it is watching goes away", async () => {
    const session = await openSession();
    const ws = connect(server.port, session.sessionId, token);
    await ws.opened;

    await webMcpSessions.close(session.sessionId);
    // No further paint is ever coming from a closed browser; a socket left
    // open would look live while feeding a pane that never updates again.
    expect((await ws.closed).code).toBe(4404);
  });
});

describe("webmcp frames WS — lifecycle", () => {
  it("shutdown closes live sockets 4503 AND refuses new handshakes", async () => {
    const session = await openSession();
    const ws = connect(server.port, session.sessionId, token);
    await ws.opened;

    shutdownWebMcpFrameSockets();
    expect((await ws.closed).code).toBe(4503);

    const after = connect(server.port, session.sessionId, token);
    expect((await after.closed).code).toBe(4503);
  });

  it("kill closes live sockets but does NOT latch", async () => {
    const session = await openSession();
    const ws = connect(server.port, session.sessionId, token);
    await ws.opened;

    killWebMcpFrameSockets();
    expect((await ws.closed).code).toBe(4503);

    // The macOS regression this guards: `window-all-closed` kills sockets and
    // then the server RESTARTS on dock activation. A latch here would 4503
    // every handshake for the rest of the process's life.
    const after = connect(server.port, session.sessionId, token);
    await after.opened;
    provider.sessions[0].emitFrame({ data: jpegBase64(0x43) });
    const decoded = decodeWebMcpBinaryFrame(await after.waitForBinary());
    expect([...decoded!.jpeg]).toEqual([0xff, 0xd8, 0x43, 0x43, 0x43]);
  });

  it("unsubscribes from the hub when the socket closes", async () => {
    const session = await openSession();
    const runtime = webMcpSessions.get(session.sessionId);
    const ws = connect(server.port, session.sessionId, token);
    await ws.opened;
    await vi.waitFor(() => expect(runtime.hub.listenerCount).toBe(1));

    ws.ws.close();
    await vi.waitFor(() => expect(runtime.hub.listenerCount).toBe(0));
  });
});

describe("ping message parsing", () => {
  it("accepts a ping", () => {
    expect(isFramePingMessage(JSON.stringify({ type: "ping" }))).toBe(true);
  });

  it("answers false for null WITHOUT throwing", () => {
    // The case worth its own test: `JSON.parse("null")` succeeds and
    // `typeof null` is `"object"`, so a naive `parsed.type` is a TypeError
    // raised inside a socket message handler. Whether the adapter absorbs
    // that is not something correctness should depend on.
    expect(() => isFramePingMessage("null")).not.toThrow();
    expect(isFramePingMessage("null")).toBe(false);
  });

  it("answers false for every other shape a client could send", () => {
    for (const payload of [
      '"ping"',
      "42",
      "true",
      "[]",
      '[{"type":"ping"}]',
      "{",
      "",
      JSON.stringify({ type: "resize", cols: 80 }),
      JSON.stringify({ type: null }),
      JSON.stringify({}),
    ]) {
      expect(() => isFramePingMessage(payload), payload).not.toThrow();
      expect(isFramePingMessage(payload), payload).toBe(false);
    }
  });
});

describe("callback socket selection", () => {
  /** A `WSContext`-shaped object with whatever `raw` a test wants to try. */
  function context(raw: unknown) {
    const fallbackSends: unknown[] = [];
    return {
      fallbackSends,
      ws: {
        raw,
        send: (data: unknown) => fallbackSends.push(data),
      } as never,
    };
  }

  it("uses a node-ws raw directly, so its send callback paces the stream", () => {
    const calls: Array<[Uint8Array, unknown]> = [];
    const raw = {
      send: (data: Uint8Array, cb: () => void) => calls.push([data, cb]),
      terminate: () => {},
    };
    const { ws } = context(raw);
    const sink = toCallbackSocket(ws);
    const bytes = new Uint8Array([1]);
    sink.send(bytes, () => {});
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe(bytes);
    // The callback reached the raw socket, which is the whole basis of the
    // pacing: it fires when the OS actually took the bytes.
    expect(typeof calls[0]![1]).toBe("function");
  });

  it("falls back for a browser-shaped raw that would ignore the callback", async () => {
    // `WSContext.raw` is adapter-specific, and only node-`ws` promises the
    // completion callback. A platform `send(data)` silently dropping a second
    // argument would leave the pacer waiting forever on a callback that never
    // comes — one frame sent, then a pane frozen with the stream healthy.
    const rawSends: unknown[] = [];
    const raw = { send: (data: unknown) => rawSends.push(data), readyState: 1 };
    const { ws, fallbackSends } = context(raw);
    const sink = toCallbackSocket(ws);

    let settled = false;
    sink.send(new Uint8Array([1]), () => {
      settled = true;
    });
    // Routed through the WSContext, not the unrecognised raw…
    expect(rawSends).toHaveLength(0);
    expect(fallbackSends).toHaveLength(1);
    // …and settled on a microtask, so pacing degrades to none rather than to
    // a wedge.
    expect(settled).toBe(false);
    await Promise.resolve();
    expect(settled).toBe(true);
  });

  it("falls back when there is no raw at all", async () => {
    const { ws, fallbackSends } = context(undefined);
    let settled = false;
    toCallbackSocket(ws).send(new Uint8Array([1]), () => {
      settled = true;
    });
    expect(fallbackSends).toHaveLength(1);
    await Promise.resolve();
    expect(settled).toBe(true);
  });

  it("keeps frames flowing through the fallback, never wedging", async () => {
    const { ws, fallbackSends } = context({ send: () => {}, readyState: 1 });
    const pacer = createFramePacer(toCallbackSocket(ws));
    for (let i = 1; i <= 4; i += 1) {
      pacer.push(new Uint8Array([i]));
      await Promise.resolve();
      await Promise.resolve();
    }
    // The property that matters: the pane keeps painting on an adapter this
    // route does not recognise.
    expect(fallbackSends).toHaveLength(4);
  });
});

describe("frame pacer", () => {
  /** A sink whose sends are settled by hand, so "in flight" is observable. */
  function handSettledSink() {
    const sent: Uint8Array[] = [];
    const callbacks: Array<() => void> = [];
    return {
      sent,
      settle: () => callbacks.shift()?.(),
      sink: {
        send(bytes: Uint8Array, cb: () => void) {
          sent.push(bytes);
          callbacks.push(cb);
        },
      },
    };
  }

  const bytes = (n: number) => new Uint8Array([n]);

  it("sends the first frame immediately", () => {
    const { sent, sink } = handSettledSink();
    createFramePacer(sink).push(bytes(1));
    expect(sent.map((b) => b[0])).toEqual([1]);
  });

  it("holds ONE frame while a send is outstanding, and ships the newest", () => {
    const { sent, settle, sink } = handSettledSink();
    const pacer = createFramePacer(sink);

    pacer.push(bytes(1));
    pacer.push(bytes(2));
    pacer.push(bytes(3));
    pacer.push(bytes(4));
    // Nothing else goes out while the first is unacknowledged: that bound is
    // the whole point — kernel-side buffering never exceeds one frame.
    expect(sent.map((b) => b[0])).toEqual([1]);

    settle();
    // The newest, not the oldest: an unseen older frame is worth nothing, and a
    // queue would make a slow consumer watch an ever-older page.
    expect(sent.map((b) => b[0])).toEqual([1, 4]);

    settle();
    expect(sent.map((b) => b[0])).toEqual([1, 4]);
  });

  it("reports a REPLACED frame, and never the first one it holds", () => {
    const { settle, sink } = handSettledSink();
    const drops: number[] = [];
    const pacer = createFramePacer(sink, () => drops.push(1));

    pacer.push(bytes(1));
    // Held while the first send is outstanding. That is the pacer working —
    // one frame of kernel-side buffering — and reporting it as pressure would
    // step the quality down on every link the moment two paints landed inside
    // one round trip.
    pacer.push(bytes(2));
    expect(drops).toHaveLength(0);

    // THIS is the loss: a frame nobody will ever see, replaced before the
    // socket took the one ahead of it.
    pacer.push(bytes(3));
    pacer.push(bytes(4));
    expect(drops).toHaveLength(2);

    settle();
    settle();
    expect(drops).toHaveLength(2);
  });

  it("keeps self-clocking across several drains", () => {
    const { sent, settle, sink } = handSettledSink();
    const pacer = createFramePacer(sink);
    pacer.push(bytes(1));
    pacer.push(bytes(2));
    settle();
    pacer.push(bytes(3));
    settle();
    settle();
    pacer.push(bytes(4));
    expect(sent.map((b) => b[0])).toEqual([1, 2, 3, 4]);
  });

  it("keeps sending when the sink settles synchronously", () => {
    // The fallback path a non-node adapter takes: no real completion signal,
    // so the pacer degrades to no pacing rather than to a wedge.
    const sent: Uint8Array[] = [];
    const pacer = createFramePacer({
      send: (b, cb) => {
        sent.push(b);
        cb();
      },
    });
    pacer.push(bytes(1));
    pacer.push(bytes(2));
    pacer.push(bytes(3));
    expect(sent.map((b) => b[0])).toEqual([1, 2, 3]);
  });

  it("wedges — by design — on a sink that never settles, which is why the adapter is checked", () => {
    // This is the failure `toCallbackSocket` refuses to walk into: a platform
    // `send(data)` that ignores a second argument leaves the callback
    // unfired, so one frame goes out and the pane freezes forever. The pacer
    // cannot detect that, which is why the ROUTE only hands it a raw socket it
    // recognises as node-`ws`.
    const sent: Uint8Array[] = [];
    const pacer = createFramePacer({
      send: (b) => {
        sent.push(b);
      },
    });
    pacer.push(bytes(1));
    pacer.push(bytes(2));
    expect(sent.map((b) => b[0])).toEqual([1]);
  });

  it("drops the held frame on close and sends nothing after it", () => {
    const { sent, settle, sink } = handSettledSink();
    const pacer = createFramePacer(sink);
    pacer.push(bytes(1));
    pacer.push(bytes(2));
    pacer.close();
    settle();
    pacer.push(bytes(3));
    expect(sent.map((b) => b[0])).toEqual([1]);
  });
});
