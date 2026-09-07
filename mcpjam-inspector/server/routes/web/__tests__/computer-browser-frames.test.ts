/**
 * The hosted browser's frame socket.
 *
 * What these hold in place: the socket is reachable only with a valid browser
 * token whose claims still match the row's live owner; the daemon-side holder
 * is the VERIFIED user and never anything the client sent; a lease refusal
 * closes with its own retryable code rather than looking like an error; and a
 * watching pane keeps the box awake, since it issues no commands to do it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createComputerBrowserFramesWsHandler,
  resetBrowserFramesForTests,
  shutdownBrowserFrameSockets,
  type BrowserFramesDeps,
} from "../computer-browser-frames";
import { resetActivityThrottleForTests } from "../../../utils/computers/activity-touch.js";
import {
  createFrameStreamDecoder,
  FRAME_STREAM_KIND,
} from "../../../services/browserd/frame-stream.js";

/** Four bytes standing in for a JPEG; `"AAAA"` once base64'd. */
const JPEG_BYTES = new Uint8Array(Buffer.from("AAAA", "base64"));

const CLAIMS = {
  userId: "users_1",
  computerId: "computers_1",
  projectId: "projects_1",
};

const SESSION = {
  sessionId: "sessions_1",
  computerId: "computers_1",
  bootId: "boot-1",
  browserdToken: "daemon-secret",
  browserdPort: 8791,
  publicOrigin: "https://box-8791.e2b.dev",
  streamUrl: "https://box-6080.e2b.dev/vnc.html",
  streamPassword: "pw",
  bundleHash: "hash-1",
  contextMode: "persistent" as const,
};

/** A `WSContext` double that records what the route did to the socket. */
function fakeSocket() {
  return {
    // Text AND bytes: one socket carries both since V-4b.
    sent: [] as Array<string | Uint8Array>,
    closed: undefined as { code: number; reason: string } | undefined,
    send(data: string | Uint8Array) {
      this.sent.push(data);
    },
    close(code: number, reason: string) {
      this.closed ??= { code, reason };
    },
  };
}

type Upstream = NonNullable<BrowserFramesDeps["openUpstream"]>;

function build(over: Partial<BrowserFramesDeps> & { counted?: boolean } = {}) {
  const { counted = true, ...depsOver } = over;
  const upstreamCalls: Parameters<Upstream>[0][] = [];
  const inputCalls: Array<{
    holder: string;
    tabId?: string;
    events: readonly unknown[];
  }> = [];
  let inputOutcome: { ok: true } | { ok: false; status: number; error: string } =
    { ok: true };
  /** Held open so a test can drive "a second batch while the first is out". */
  let releaseInput: (() => void) | null = null;
  const touchSession = vi.fn(async () => ({ counted }));
  let daemonFeatures: readonly string[] = [];
  const qualityCalls: string[] = [];
  const touchActivity = vi.fn(async () => {});

  // Captures the handlers the route hands back, so a test can drive the socket
  // lifecycle without a real upgrade.
  let events: Record<string, (...args: never[]) => unknown> = {};
  const upgradeWebSocket = ((
    createEvents: (c: unknown) => Promise<unknown>,
  ) => {
    return async (c: unknown) => {
      events = (await createEvents(c)) as typeof events;
      return events;
    };
  }) as never;

  const handler = createComputerBrowserFramesWsHandler(upgradeWebSocket, {
    configured: () => true,
    verifyToken: (async (token: string) =>
      token === "tok" ? CLAIMS : null) as BrowserFramesDeps["verifyToken"],
    sandboxInfo: (async () => ({
      ok: true,
      value: {
        ownerUserId: CLAIMS.userId,
        projectId: CLAIMS.projectId,
        providerComputerId: "sbx_1",
      },
    })) as unknown as BrowserFramesDeps["sandboxInfo"],
    lookupSession: (async () => ({
      reachable: true,
      session: SESSION,
    })) as unknown as BrowserFramesDeps["lookupSession"],
    touchSession: touchSession as unknown as BrowserFramesDeps["touchSession"],
    touchActivity:
      touchActivity as unknown as BrowserFramesDeps["touchActivity"],
    bundleHash: () => "hash-1",
    openUpstream: (async (args) => {
      upstreamCalls.push(args);
      return { ok: true };
    }) as Upstream,
    setQuality: (async (args: { tier: string }) => {
      qualityCalls.push(args.tier);
      return { ok: true as const };
    }) as BrowserFramesDeps["setQuality"],
    daemonStatus: (async () => ({
      kind: "ok" as const,
      bootId: SESSION.bootId,
      features: daemonFeatures,
    })) as BrowserFramesDeps["daemonStatus"],
    sendInput: (async (args: {
      holder: string;
      tabId?: string;
      events: readonly unknown[];
    }) => {
      inputCalls.push(args);
      if (releaseInput) {
        await new Promise<void>((resolve) => {
          const previous = releaseInput;
          releaseInput = () => {
            previous?.();
            resolve();
          };
        });
      }
      return inputOutcome;
    }) as BrowserFramesDeps["sendInput"],
    ...depsOver,
  });

  /** Run the pre-upgrade resolution and open the socket. */
  async function connect(token: string | null = "tok", query = "") {
    const ctx = {
      req: {
        header: (name: string) =>
          name.toLowerCase() === "sec-websocket-protocol" && token
            ? token
            : undefined,
        query: (name: string) =>
          new URLSearchParams(query).get(name) ?? undefined,
      },
    };
    await (handler as unknown as (c: unknown) => Promise<unknown>)(ctx);
    const ws = fakeSocket();
    await (
      events.onOpen as unknown as (e: unknown, w: unknown) => Promise<void>
    )({}, ws);
    return { ws, events };
  }

  return {
    connect,
    upstreamCalls,
    inputCalls,
    touchSession,
    touchActivity,
    setInputOutcome(next: typeof inputOutcome) {
      inputOutcome = next;
    },
    qualityCalls,
    /** What the daemon says it can do. Empty unless a test grants it. */
    setDaemonFeatures(next: readonly string[]) {
      daemonFeatures = next;
    },
    holdInput() {
      releaseInput = () => {};
    },
    releaseInput() {
      const release = releaseInput;
      releaseInput = null;
      release?.();
    },
  };
}

beforeEach(() => {
  resetBrowserFramesForTests();
  // The activity throttle is process-wide and keyed by computer id, which
  // every case here shares: without this the first touch in the file would
  // suppress every later one for a minute.
  resetActivityThrottleForTests();
  vi.useRealTimers();
});

describe("browser frames socket — who may watch", () => {
  it("closes 4401 without a token, and never opens an upstream", async () => {
    const f = build();
    const { ws } = await f.connect(null);
    expect(ws.closed?.code).toBe(4401);
    expect(f.upstreamCalls).toHaveLength(0);
  });

  it("closes 4401 when the row's owner no longer matches the token", async () => {
    // The mint authorized this about a minute ago; ownership can move inside
    // that window, and the socket shows a live screen.
    const f = build({
      sandboxInfo: (async () => ({
        ok: true,
        value: {
          ownerUserId: "users_someone_else",
          projectId: CLAIMS.projectId,
          providerComputerId: "sbx_1",
        },
      })) as unknown as BrowserFramesDeps["sandboxInfo"],
    });
    const { ws } = await f.connect();
    expect(ws.closed?.code).toBe(4401);
    expect(f.upstreamCalls).toHaveLength(0);
  });

  it("closes 4404 when no browser is running on that computer", async () => {
    const f = build({
      lookupSession: (async () => ({
        reachable: true,
        session: null,
      })) as unknown as BrowserFramesDeps["lookupSession"],
    });
    const { ws } = await f.connect();
    expect(ws.closed?.code).toBe(4404);
  });

  it("asks the daemon on behalf of the VERIFIED user, not the caller", async () => {
    // The daemon lets a subscriber through when `holder === lease.holder`. A
    // holder taken from the client would let anyone who echoed the right id
    // watch somebody else's HELD session — a password field mid-typing.
    const f = build();
    await f.connect("tok", "holder=users_victim&tabId=tab-9");
    expect(f.upstreamCalls[0]).toMatchObject({
      holder: CLAIMS.userId,
      tabId: "tab-9",
    });
    expect(f.upstreamCalls[0].holder).not.toBe("users_victim");
  });
});

describe("browser frames socket — carrying frames", () => {
  it("relays a frame in the envelope the local pane already reads", async () => {
    const f = build();
    const { ws } = await f.connect();
    f.upstreamCalls[0].onFrame({
      jpeg: JPEG_BYTES,
      deviceWidth: 1024,
      deviceHeight: 768,
      scale: 1,
      ts: 5,
      seq: 3,
    });
    // `sent[0]` is the `hello`; the frame is the next thing out.
    const message = ws.sent
      .map((raw) => JSON.parse(String(raw)))
      .find((entry) => entry.type === "frame");
    expect(message).toMatchObject({
      type: "frame",
      frame: {
        // Base64 on the JSON wire, which is what a pane that asked for nothing
        // still gets.
        data: "AAAA",
        deviceWidth: 1024,
        deviceHeight: 768,
        scale: 1,
        ts: 5,
        seq: 3,
      },
    });
    // The sandbox's `ts` is not comparable to the viewer's clock — different
    // machines — so the relay adds its OWN stamp, which is the hop the pane
    // measures its round trip against.
    expect(message.frame.relayTs).toBeGreaterThan(0);
  });

  it("echoes the pane's ping stamp so a round trip is measurable", async () => {
    const f = build();
    const { ws, events } = await f.connect();
    (events.onMessage as unknown as (e: unknown, w: unknown) => void)(
      { data: JSON.stringify({ type: "ping", t: 4242 }) },
      ws,
    );
    expect(ws.sent.map((raw) => JSON.parse(String(raw)))).toContainEqual({
      type: "pong",
      t: 4242,
    });
  });

  it("reports what it forwarded on a cadence", async () => {
    vi.useFakeTimers();
    try {
      const f = build();
      const { ws } = await f.connect();
      f.upstreamCalls[0].onFrame({
        jpeg: JPEG_BYTES,
        deviceWidth: 1024,
        deviceHeight: 768,
        scale: 1,
        ts: 5,
        seq: 3,
      });
      expect(ws.sent.some((raw) => String(raw).includes('"stats"'))).toBe(
        false,
      );
      vi.advanceTimersByTime(1_000);
      const stats = ws.sent
        .map((raw) => JSON.parse(String(raw)))
        .find((message) => message.type === "stats");
      expect(stats).toMatchObject({ framesIn: 1, framesOut: 1, dropped: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes 4409 — retryable — when the lease moves", async () => {
    // Its own code because it is TEMPORARY: a pane should hold its place and
    // come back, not show the person an error about a browser that is fine.
    const f = build();
    const { ws } = await f.connect();
    f.upstreamCalls[0].onEnd("lease_held");
    expect(ws.closed).toMatchObject({ code: 4409, reason: "lease_held" });
  });

  it("closes 4404 for a tab that went away", async () => {
    const f = build();
    const { ws } = await f.connect();
    f.upstreamCalls[0].onEnd("tab_gone");
    expect(ws.closed?.code).toBe(4404);
  });

  it("treats an UNEXPLAINED end as a drop, not as a refusal", async () => {
    // `undefined` means the daemon never said why — a dropped link rather than
    // a decision, and the pane should reconnect rather than stand down.
    const f = build();
    const { ws } = await f.connect();
    f.upstreamCalls[0].onEnd(undefined);
    expect(ws.closed?.code).toBe(4503);
  });

  it("closes when the upstream refuses to start", async () => {
    const f = build({
      openUpstream: (async () => ({
        ok: false as const,
        status: 404,
        error: "http_404",
      })) as Upstream,
    });
    const { ws } = await f.connect();
    expect(ws.closed?.code).toBe(4404);
  });
});

describe("browser frames socket — keeping the box awake", () => {
  it("touches the session and the computer as soon as somebody watches", async () => {
    // A watching pane issues no COMMANDS, so nothing else defers the idle
    // sweep — and the browser would be reaped out from under the person
    // looking at it.
    const f = build();
    await f.connect();
    expect(f.touchSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION.sessionId, kind: "panel" }),
    );
    // Awaited now rather than fired alongside: the box is only touched once
    // the backend says this panel still counts.
    await vi.waitFor(() =>
      expect(f.touchActivity).toHaveBeenCalledWith({
        computerId: SESSION.computerId,
      }),
    );
  });

  it("does not hold the box awake once the backend stops counting the panel", async () => {
    // The ceiling `/keepalive` already honours: a browser idle of real
    // commands for long enough stops being kept awake by somebody merely
    // looking at it. Discarding `counted` and touching anyway bypassed it, so
    // a pinging pane held a metered box open with no limit at all — the same
    // bug as the connected-but-unwatched socket, one layer further in.
    const f = build({ counted: false });
    await f.connect();
    await vi.waitFor(() =>
      expect(f.touchSession).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "panel" }),
      ),
    );
    expect(f.touchActivity).not.toHaveBeenCalled();
  });

  it("stops touching a pane nobody is looking at", async () => {
    // AN OPEN SOCKET IS NOT SOMEBODY WATCHING. The pane stays connected behind
    // the rail's other tabs and in a background browser tab — dropping it
    // would stop the screencast and make the browser go dark on every glance —
    // and stops PINGING in both cases. Without this gate a pane left open
    // behind the Logs tab holds a metered cloud box awake indefinitely, and
    // the person pays for it.
    vi.useFakeTimers();
    const f = build();
    await f.connect();
    f.touchSession.mockClear();
    f.touchActivity.mockClear();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(f.touchSession).not.toHaveBeenCalled();
    expect(f.touchActivity).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("keeps touching while the pane says somebody is looking", async () => {
    vi.useFakeTimers();
    const f = build();
    const { events, ws } = await f.connect();
    f.touchSession.mockClear();
    const ping = () =>
      (events.onMessage as unknown as (e: unknown, w: unknown) => void)(
        { data: JSON.stringify({ type: "ping" }) },
        ws,
      );

    // INTERLEAVED, because pinging before every interval cannot fail: the
    // timer fires either way and the count is the same with the gate deleted.
    // Skipping the middle window is what makes the assertion about the ping
    // rather than about the clock.
    ping();
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000); // no ping — this one must not touch
    ping();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(f.touchSession).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("stops touching once the socket is gone", async () => {
    vi.useFakeTimers();
    const f = build();
    const { events } = await f.connect();
    f.touchSession.mockClear();
    (events.onClose as unknown as () => void)();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(f.touchSession).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("does not touch a computer for a pane that hung up mid-touch", async () => {
    // The session touch is a round trip, and the socket can close while it is
    // in flight. Its continuation then reached a computer for a pane that is
    // gone — one more minute of a metered box kept awake per disconnect.
    let settle: (value: { counted: boolean }) => void = () => {};
    const touchSession = vi.fn(
      () =>
        new Promise<{ counted: boolean }>((resolve) => {
          settle = resolve;
        }),
    );
    const f = build({
      touchSession:
        touchSession as unknown as BrowserFramesDeps["touchSession"],
    });
    const { events } = await f.connect();
    (events.onClose as unknown as () => void)();
    settle({ counted: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(f.touchActivity).not.toHaveBeenCalled();
  });

  it("hangs up the daemon stream when the pane closes", async () => {
    // Otherwise the screencast and its encoder keep running on a box the agent
    // is still using, for a pane nobody has open.
    const f = build();
    const { events } = await f.connect();
    const { signal } = f.upstreamCalls[0];
    expect(signal.aborted).toBe(false);
    (events.onClose as unknown as () => void)();
    expect(signal.aborted).toBe(true);
  });

  it("refuses new sockets once the server is shutting down", async () => {
    shutdownBrowserFrameSockets();
    const f = build();
    const { ws } = await f.connect();
    expect(ws.closed?.code).toBe(4503);
    expect(f.upstreamCalls).toHaveLength(0);
  });
});


describe("browser frames socket — input on the socket", () => {
  /** Drive one client message through the route's handler. */
  function say(
    events: Record<string, (...args: never[]) => unknown>,
    ws: unknown,
    message: unknown,
  ) {
    (events.onMessage as unknown as (e: unknown, w: unknown) => void)(
      { data: JSON.stringify(message) },
      ws,
    );
  }

  it("advertises what it can do before the pane has to guess", async () => {
    const f = build();
    const { ws } = await f.connect();
    expect(JSON.parse(String(ws.sent[0]))).toEqual({
      type: "hello",
      features: ["input"],
      codecs: ["jpeg"],
      codec: "jpeg",
      // A pane that asked for nothing gets the envelope it has always got.
      wire: "json",
    });
  });

  it("dispatches with the holder from the TOKEN, never the wire", async () => {
    const f = build();
    const { ws, events } = await f.connect();
    say(events, ws, {
      type: "input",
      seq: 1,
      // A holder read off the wire would let anyone who echoed the right id
      // type into somebody else's held session — a password field, mid-login.
      holder: "users_victim",
      events: [{ type: "mouse_move", x: 4, y: 5 }],
    });
    await vi.waitFor(() => expect(f.inputCalls).toHaveLength(1));
    expect(f.inputCalls[0]).toMatchObject({
      holder: CLAIMS.userId,
      events: [{ type: "mouse_move", x: 4, y: 5 }],
    });
    await vi.waitFor(() =>
      expect(
        ws.sent.map((raw) => JSON.parse(String(raw))).some((m) => m.type === "input_ack"),
      ).toBe(true),
    );
    expect(
      ws.sent.map((raw) => JSON.parse(String(raw))).find((m) => m.type === "input_ack"),
    ).toEqual({ type: "input_ack", seq: 1, dispatched: 1 });
  });

  it("answers a lease refusal with an ack, not a close", async () => {
    // "Somebody else has the browser" is the ordinary state of affairs while
    // the agent is driving. A close would put the pane in a reconnect loop
    // against a browser that is working exactly as designed.
    const f = build();
    f.setInputOutcome({ ok: false, status: 423, error: "lease_held" });
    const { ws, events } = await f.connect();
    say(events, ws, {
      type: "input",
      seq: 9,
      events: [{ type: "text", text: "hi" }],
    });
    await vi.waitFor(() =>
      expect(
        ws.sent.map((raw) => JSON.parse(String(raw))).some((m) => m.type === "input_ack"),
      ).toBe(true),
    );
    expect(
      ws.sent.map((raw) => JSON.parse(String(raw))).find((m) => m.type === "input_ack"),
    ).toEqual({
      type: "input_ack",
      seq: 9,
      dispatched: 0,
      refused: "lease_held",
    });
    expect(ws.closed).toBeUndefined();
  });

  it("refuses a malformed batch whole, and stays open", async () => {
    const f = build();
    const { ws, events } = await f.connect();
    say(events, ws, {
      type: "input",
      seq: 3,
      // Filtering would deliver a drag missing its release, leaving the page
      // holding a button down with nothing to say why.
      events: [{ type: "mouse_down", x: 1, y: 1, button: "left" }, { type: "?" }],
    });
    expect(
      ws.sent.map((raw) => JSON.parse(String(raw))).find((m) => m.type === "input_ack"),
    ).toEqual({
      type: "input_ack",
      seq: 3,
      dispatched: 0,
      refused: "invalid_input",
    });
    expect(f.inputCalls).toHaveLength(0);
    expect(ws.closed).toBeUndefined();
  });

  it("keeps one dispatch in flight and coalesces what queues behind it", async () => {
    // A socket is ordered; the POST behind it is not. N concurrent POSTs
    // arrive in whatever order the network felt like, and an out-of-order drag
    // lands where nobody aimed.
    const f = build();
    const { ws, events } = await f.connect();
    f.holdInput();
    say(events, ws, {
      type: "input",
      seq: 1,
      events: [{ type: "mouse_move", x: 1, y: 1 }],
    });
    await vi.waitFor(() => expect(f.inputCalls).toHaveLength(1));
    say(events, ws, {
      type: "input",
      seq: 2,
      events: [{ type: "mouse_move", x: 2, y: 2 }],
    });
    say(events, ws, {
      type: "input",
      seq: 3,
      events: [
        { type: "mouse_move", x: 3, y: 3 },
        { type: "mouse_up", x: 3, y: 3, button: "left" },
      ],
    });
    expect(f.inputCalls).toHaveLength(1);

    f.releaseInput();
    await vi.waitFor(() => expect(f.inputCalls).toHaveLength(2));
    // The queued moves collapsed to the one they stopped at, with the release
    // still behind it and in order.
    expect(f.inputCalls[1]?.events).toEqual([
      { type: "mouse_move", x: 3, y: 3 },
      { type: "mouse_up", x: 3, y: 3, button: "left" },
    ]);
    // Both queued messages get their own ack.
    await vi.waitFor(() => {
      const acks = ws.sent
        .map((raw) => JSON.parse(String(raw)))
        .filter((m) => m.type === "input_ack");
      expect(acks.map((a) => a.seq)).toEqual([1, 2, 3]);
    });
  });

  it("counts a landed dispatch as real use of a metered box", async () => {
    // Somebody who took control to solve a CAPTCHA issues no agent commands at
    // all. Left as a panel touch, their box would hibernate while they typed.
    const f = build();
    const { ws, events } = await f.connect();
    // AFTER the open, whose own touch spends the per-computer window.
    resetActivityThrottleForTests();
    f.touchSession.mockClear();
    say(events, ws, {
      type: "input",
      seq: 1,
      events: [{ type: "text", text: "hi" }],
    });
    await vi.waitFor(() =>
      expect(f.touchSession).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "command" }),
      ),
    );
  });

  it("does not count a REFUSED dispatch", async () => {
    const f = build();
    f.setInputOutcome({ ok: false, status: 423, error: "lease_held" });
    const { ws, events } = await f.connect();
    resetActivityThrottleForTests();
    f.touchSession.mockClear();
    say(events, ws, {
      type: "input",
      seq: 1,
      events: [{ type: "text", text: "hi" }],
    });
    await vi.waitFor(() =>
      expect(
        ws.sent.map((raw) => JSON.parse(String(raw))).some((m) => m.type === "input_ack"),
      ).toBe(true),
    );
    expect(f.touchSession).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "command" }),
    );
  });

  it("drops what is queued when the socket goes away", async () => {
    const f = build();
    const { ws, events } = await f.connect();
    f.holdInput();
    say(events, ws, {
      type: "input",
      seq: 1,
      events: [{ type: "text", text: "a" }],
    });
    await vi.waitFor(() => expect(f.inputCalls).toHaveLength(1));
    say(events, ws, {
      type: "input",
      seq: 2,
      events: [{ type: "text", text: "b" }],
    });
    (events.onClose as unknown as () => void)();
    f.releaseInput();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Whatever was queued belonged to the hold that queued it; delivering it
    // afterwards types into whoever holds the browser next.
    expect(f.inputCalls).toHaveLength(1);
  });
});


/**
 * V-4b. The pixel path stopped being base64 in a JSON envelope. What these pin
 * is that the change is NEGOTIATED — a pane that predates it keeps the wire it
 * has always had — and that the record forwarded is the daemon's own, byte for
 * byte except the one field that has to be rewritten.
 */
describe("browser frames socket — the binary wire", () => {
  const FRAME = {
    jpeg: JPEG_BYTES,
    deviceWidth: 1024,
    deviceHeight: 768,
    scale: 1,
    ts: 5,
    seq: 3,
  };

  it("answers the wire the pane asked for", async () => {
    const f = build();
    const { ws } = await f.connect("tok", "wire=binary");
    expect(JSON.parse(String(ws.sent[0]))).toMatchObject({ wire: "binary" });
  });

  it("forwards the daemon's record, rewriting only the timestamp", async () => {
    const f = build();
    const { ws } = await f.connect("tok", "wire=binary");
    const before = Date.now();
    f.upstreamCalls[0].onFrame(FRAME);

    const binary = ws.sent.find((entry) => entry instanceof Uint8Array) as
      | Uint8Array
      | undefined;
    expect(binary).toBeDefined();
    const decoded = createFrameStreamDecoder().push(binary!);
    expect(decoded.ok).toBe(true);
    const record = decoded.ok ? decoded.records[0] : undefined;
    expect(record).toMatchObject({
      kind: FRAME_STREAM_KIND.frame,
      deviceWidth: 1024,
      deviceHeight: 768,
      scale: 1,
      seq: 3,
      jpeg: JPEG_BYTES,
    });
    // The SANDBOX's `ts` is not comparable to the viewer's clock — different
    // machines — so this hop stamps its own, and that is the one the pane
    // measured its round trip against.
    expect(
      (record as { ts: number }).ts,
    ).toBeGreaterThanOrEqual(before);
    expect((record as { ts: number }).ts).not.toBe(5);
    // And NOT a JSON frame beside it: one wire, not two.
    expect(
      ws.sent
        .filter((entry) => typeof entry === "string")
        .some((raw) => String(raw).includes('"frame"')),
    ).toBe(false);
  });

  it("keeps the JSON envelope for a pane that asked for nothing", async () => {
    // A client build cached in somebody's tab predates the parameter. It must
    // keep working, unchanged, for a release.
    const f = build();
    const { ws } = await f.connect();
    f.upstreamCalls[0].onFrame(FRAME);
    expect(ws.sent.some((entry) => entry instanceof Uint8Array)).toBe(false);
    const message = ws.sent
      .filter((entry) => typeof entry === "string")
      .map((raw) => JSON.parse(String(raw)))
      .find((entry) => entry.type === "frame");
    expect(message.frame.data).toBe("AAAA");
  });

  it("still speaks JSON for control on the binary wire", async () => {
    // Pixels are bytes and control is text, on ONE socket: an ack that arrived
    // as bytes would have to be told apart from a frame by inspection.
    const f = build();
    const { ws, events } = await f.connect("tok", "wire=binary");
    (events.onMessage as unknown as (e: unknown, w: unknown) => void)(
      { data: JSON.stringify({ type: "ping", t: 9 }) },
      ws,
    );
    expect(
      ws.sent
        .filter((entry) => typeof entry === "string")
        .map((raw) => JSON.parse(String(raw))),
    ).toContainEqual({ type: "pong", t: 9 });
  });
});


/**
 * V-5. Video is NEGOTIATED twice over: the pane asks only when its browser has
 * a `VideoDecoder`, and the relay asks the daemon only when it advertised the
 * capability. Either "no" leaves the stream on JPEG, which is the same
 * fallback everything else in this wave takes.
 */
describe("browser frames socket — negotiating h264", () => {
  it("agrees only when the daemon says it can encode", async () => {
    const f = build();
    f.setDaemonFeatures(["h264"]);
    const { ws } = await f.connect("tok", "wire=binary&codec=h264");
    expect(JSON.parse(String(ws.sent[0]))).toMatchObject({
      codec: "h264",
      codecs: ["jpeg", "h264"],
    });
    expect(f.upstreamCalls[0]?.codec).toBe("h264");
  });

  it("stays on JPEG against a daemon that never advertised it", async () => {
    // A daemon too old to encode would answer an error stream, and a reader
    // cannot tell that apart from a dead browser.
    const f = build();
    const { ws } = await f.connect("tok", "wire=binary&codec=h264");
    expect(JSON.parse(String(ws.sent[0]))).toMatchObject({
      codec: "jpeg",
      codecs: ["jpeg"],
    });
    expect(f.upstreamCalls[0]?.codec).toBeUndefined();
  });

  it("never asks for video on the JSON wire", async () => {
    // An access unit in a JSON envelope would be base64 again, which is the
    // cost the binary wire exists to remove.
    const f = build();
    f.setDaemonFeatures(["h264"]);
    const { ws } = await f.connect("tok", "codec=h264");
    expect(JSON.parse(String(ws.sent[0]))).toMatchObject({ codec: "jpeg" });
  });

  it("forwards an access unit as a video record", async () => {
    const f = build();
    f.setDaemonFeatures(["h264"]);
    const { ws } = await f.connect("tok", "wire=binary&codec=h264");
    const before = Date.now();
    f.upstreamCalls[0].onVideo?.({
      key: true,
      au: new Uint8Array([0, 0, 0, 1, 9, 0x10, 0, 0, 1, 5, 0xaa]),
      deviceWidth: 1024,
      deviceHeight: 768,
      scale: 1,
      ts: 5,
      seq: 2,
    });
    const binary = ws.sent.find((entry) => entry instanceof Uint8Array) as
      | Uint8Array
      | undefined;
    expect(binary).toBeDefined();
    const decoded = createFrameStreamDecoder({ video: true }).push(binary!);
    expect(decoded.ok && decoded.records[0]).toMatchObject({
      kind: FRAME_STREAM_KIND.video_key,
      deviceWidth: 1024,
      seq: 2,
    });
    // Stamped by THIS hop, like every other frame.
    expect(
      (decoded.ok ? (decoded.records[0] as { ts: number }).ts : 0),
    ).toBeGreaterThanOrEqual(before);
  });

  it("keeps the JPEG path for a per-tab watch", async () => {
    // The encoder grabs the X display, which has no concept of a tab — so
    // watching ONE tab is JPEG whatever the browser can decode. The relay
    // still asks for video (the pane did), and the daemon ignores `tabId` on
    // that stream; a pane that wants a specific tab asks for `codec=jpeg`.
    const f = build();
    f.setDaemonFeatures(["h264"]);
    await f.connect("tok", "wire=binary&tabId=tab-2");
    expect(f.upstreamCalls[0]?.tabId).toBe("tab-2");
    expect(f.upstreamCalls[0]?.codec).toBeUndefined();
  });
});


/**
 * V-7. A tier is not a lease-gated action: it changes how the picture is
 * ENCODED, not what it shows, and somebody watching on a bad link needs to be
 * able to turn the bitrate down without taking the browser away from the agent.
 */
describe("browser frames socket — quality", () => {
  function say(
    events: Record<string, (...args: never[]) => unknown>,
    ws: unknown,
    message: unknown,
  ) {
    (events.onMessage as unknown as (e: unknown, w: unknown) => void)(
      { data: JSON.stringify(message) },
      ws,
    );
  }

  it("forwards a tier to the daemon", async () => {
    const f = build();
    const { ws, events } = await f.connect();
    say(events, ws, { type: "quality", tier: "saver" });
    await vi.waitFor(() => expect(f.qualityCalls).toEqual(["saver"]));
  });

  it("ignores a tier the encoder has no preset for", async () => {
    // The client's own `mjpeg` and `vnc` are choices about which transport to
    // use at all; sending them here would ask an encoder for a mode it does
    // not have.
    const f = build();
    const { ws, events } = await f.connect();
    say(events, ws, { type: "quality", tier: "mjpeg" });
    say(events, ws, { type: "quality", tier: 7 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.qualityCalls).toEqual([]);
    expect(ws.closed).toBeUndefined();
  });

  it("does not need the lease", async () => {
    // Turning the bitrate down must not require taking the browser away from
    // the agent.
    const f = build();
    const { ws, events } = await f.connect();
    say(events, ws, { type: "quality", tier: "sharp" });
    await vi.waitFor(() => expect(f.qualityCalls).toEqual(["sharp"]));
  });
});
