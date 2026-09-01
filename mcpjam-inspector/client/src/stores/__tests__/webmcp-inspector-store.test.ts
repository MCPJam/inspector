/**
 * The store holds the surface's easiest-to-get-wrong logic: SSE frame parsing,
 * activity bookkeeping across reconnects, and pending-invocation state that
 * decides whether Invoke is disabled.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  setFramePresenterForTests,
  useWebmcpInspectorStore,
} from "../webmcp-inspector-store";
import { createFramePresenter } from "@/lib/webmcp-inspector/frame-presenter";
import * as sessionToken from "@/lib/session-token";
import {
  frameStatsReport,
  notePainted,
  noteInputSent,
  resetFrameStatsFlagForTests,
} from "@/lib/webmcp-inspector/frame-stats";
import { encodeWebMcpBinaryFrame } from "@/shared/webmcp-inspector-protocol";
import type {
  WebMcpActivityEntry,
  WebMcpEvent,
  WebMcpSessionPublic,
  WebMcpToolDescriptor,
} from "@/shared/webmcp-inspector-protocol";

/** Captured EventSource instances, so a test can push frames at the store. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

vi.stubGlobal("EventSource", FakeEventSource as never);

/**
 * Captured WebSocket instances, so a test can drive the frame socket by hand.
 *
 * Injected by stubbing the global rather than through a store-level seam: the
 * connection module's default factory is `new WebSocket(url, protocols)`, so
 * stubbing here exercises the real construction path — including the
 * subprotocol the token rides on, which is the thing worth asserting.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  binaryType = "";
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  closedByClient = false;

  constructor(
    readonly url: string,
    readonly protocols?: string[],
  ) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  /** The client asking to close. A real socket still fires `onclose` after. */
  close() {
    this.closedByClient = true;
    this.readyState = FakeWebSocket.CLOSED;
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  emitFrame(frame: Parameters<typeof encodeWebMcpBinaryFrame>[0]) {
    const encoded = encodeWebMcpBinaryFrame(frame);
    this.onmessage?.({
      data: encoded.buffer.slice(
        encoded.byteOffset,
        encoded.byteOffset + encoded.byteLength,
      ),
    });
  }

  emitClose(code: number, reason = "") {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

vi.stubGlobal("WebSocket", FakeWebSocket as never);

/** A frame-stream session: the only kind that opens a frame socket. */
const FRAME_SESSION: WebMcpSessionPublic = {
  sessionId: "session-1",
  status: "ready",
  url: "https://shop.test/",
  createdAt: 1,
  expiresAt: 2,
  hardExpiresAt: 3,
  viewportTransport: { kind: "frame-stream", width: 1280, height: 800 },
  protocolVersion: 1,
};

const JPEG = new Uint8Array([0xff, 0xd8, 0x11, 0x22]);

function binaryFrame(seq: number, overrides: Record<string, unknown> = {}) {
  return {
    deviceWidth: 1280,
    deviceHeight: 800,
    ts: 5_000,
    seq,
    jpeg: JPEG,
    ...overrides,
  };
}

const SESSION: WebMcpSessionPublic = {
  sessionId: "session-1",
  status: "ready",
  url: "https://shop.test/",
  createdAt: 1,
  expiresAt: 2,
  hardExpiresAt: 3,
  viewportTransport: { kind: "native-window" },
  protocolVersion: 1,
};

const TOOL: WebMcpToolDescriptor = {
  toolKey: "https://shop.test::add_to_cart",
  name: "add_to_cart",
  origin: "https://shop.test",
  fromSubframe: false,
  description: "Add an item",
  registrationKind: "imperative",
};

/** A `liveFrame` in the store's normalized shape. */
function liveFrame(data: string, seq = 2) {
  return {
    src: `data:image/jpeg;base64,${data}`,
    deviceWidth: 1280,
    deviceHeight: 800,
    // Same numbers at scale 1, and deliberately still stated: the pane lays
    // out and scales clicks against these, not the device ones.
    cssWidth: 1280,
    cssHeight: 800,
    ts: 1,
    seq,
  };
}

function activityEvent(entry: WebMcpActivityEntry, seq = 1): WebMcpEvent {
  return { type: "activity", seq, entry };
}

function started(id: string, invokeId: string): WebMcpActivityEntry {
  return {
    id,
    ts: 10,
    kind: "invocation_started",
    invokeId,
    toolKey: TOOL.toolKey,
    source: "manual",
    input: {},
  };
}

function settled(id: string, invokeId: string): WebMcpActivityEntry {
  return {
    id,
    ts: 20,
    kind: "invocation_settled",
    invokeId,
    toolKey: TOOL.toolKey,
    source: "manual",
    state: "succeeded",
    durationMs: 10,
    output: "ok",
  };
}

/**
 * A `fetch` the test settles by hand, for asserting what happens to a response
 * that lands after the session it was asked for has gone.
 */
function deferredFetch() {
  let release!: (response: Response) => void;
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  return { fetchSpy, release: (response: Response) => release(response) };
}

/** Open a session through the real action, with `fetch` stubbed. */
async function openSession(session: WebMcpSessionPublic = SESSION) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(session), { status: 201 }),
  );
  await useWebmcpInspectorStore.getState().startSession("https://shop.test/");
  return FakeEventSource.instances.at(-1)!;
}

/** Open a frame-stream session and hand back both of its transports. */
async function openFrameSession(sessionId = "session-1") {
  const sse = await openSession({ ...FRAME_SESSION, sessionId });
  return { sse, ws: FakeWebSocket.instances.at(-1)! };
}

describe("webmcp inspector store", () => {
  let urls: string[] = [];
  let revoked: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    // The stream handle is module-scoped and `connect` is idempotent per
    // session id, so without this the next test reuses the previous stream and
    // never gets a FakeEventSource of its own.
    useWebmcpInspectorStore.getState().disconnect();
    FakeEventSource.instances = [];
    FakeWebSocket.instances = [];
    // The token the frame socket carries as its subprotocol. Set on `window`
    // because that is where the real one is injected.
    (
      window as unknown as { __MCP_SESSION_TOKEN__?: string }
    ).__MCP_SESSION_TOKEN__ = "test-token";
    // jsdom has no object-URL plumbing, and the store's default presenter
    // reaches for it on the first WS frame.
    urls = [];
    revoked = [];
    setFramePresenterForTests(
      createFramePresenter({
        createUrl: () => {
          const url = `blob:frame-${urls.length}`;
          urls.push(url);
          return url;
        },
        revokeUrl: (url) => revoked.push(url),
        defer: (fn) => fn(),
      }),
    );
    vi.restoreAllMocks();
    useWebmcpInspectorStore.setState({
      session: undefined,
      tools: [],
      activity: [],
      pending: [],
      starting: false,
      error: undefined,
      liveFrame: undefined,
      frameTransport: { rung: "none", attempts: 0, latched: false },
      lastScreenshot: undefined,
      chatEnabled: false,
    });
  });

  it("applies session, tools and activity frames", async () => {
    const source = await openSession();
    source.emit({ type: "tools", seq: 2, tools: [TOOL] });
    source.emit(activityEvent(started("a1", "inv-1"), 3));

    const state = useWebmcpInspectorStore.getState();
    expect(state.session?.sessionId).toBe("session-1");
    expect(state.tools).toHaveLength(1);
    expect(state.activity.map((entry) => entry.id)).toEqual(["a1"]);
    expect(state.pending.map((item) => item.invokeId)).toEqual(["inv-1"]);
  });

  it("clears pending once an invocation settles", async () => {
    const source = await openSession();
    source.emit(activityEvent(started("a1", "inv-1")));
    source.emit(activityEvent(settled("a2", "inv-1"), 2));
    expect(useWebmcpInspectorStore.getState().pending).toEqual([]);
  });

  it("ignores an activity entry it has already applied", async () => {
    const source = await openSession();
    source.emit(activityEvent(started("a1", "inv-1")));
    source.emit(activityEvent(settled("a2", "inv-1"), 2));
    // EventSource reconnects on its own and the server replays the ring, so the
    // same entries arrive again. Appending them would double the timeline, hand
    // React duplicate keys, and re-add a pending invocation that already
    // finished — leaving Invoke disabled forever.
    source.emit(activityEvent(started("a1", "inv-1")));
    source.emit(activityEvent(settled("a2", "inv-1"), 2));

    const state = useWebmcpInspectorStore.getState();
    expect(state.activity.map((entry) => entry.id)).toEqual(["a1", "a2"]);
    expect(state.pending).toEqual([]);
  });

  it("does not resurrect pending when only the start is replayed", async () => {
    const source = await openSession();
    source.emit(activityEvent(started("a1", "inv-1")));
    source.emit(activityEvent(settled("a2", "inv-1"), 2));
    // The settle has scrolled out of the replay window; only the start returns.
    source.emit(activityEvent(started("a1", "inv-1")));
    expect(useWebmcpInspectorStore.getState().pending).toEqual([]);
  });

  it("reattaches the stream to a live session on reconnect", async () => {
    await openSession();
    useWebmcpInspectorStore.getState().disconnect();
    expect(FakeEventSource.instances.at(-1)!.closed).toBe(true);

    // Navigating away and back must resume the stream, or tool registrations
    // and invocation results never arrive again and an invoke appears to hang.
    useWebmcpInspectorStore.getState().reconnect();
    const resumed = FakeEventSource.instances.at(-1)!;
    expect(resumed.closed).toBe(false);
    resumed.emit({ type: "tools", seq: 9, tools: [TOOL] });
    expect(useWebmcpInspectorStore.getState().tools).toHaveLength(1);
  });

  it("does nothing on reconnect when there is no session", () => {
    useWebmcpInspectorStore.getState().reconnect();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("reports a session that went away and drops its state", async () => {
    const source = await openSession();
    source.emit({ type: "session_gone", error: "That session is gone." });

    const state = useWebmcpInspectorStore.getState();
    expect(state.session).toBeUndefined();
    expect(state.error?.code).toBe("session-not-found");
  });

  it("survives a malformed frame and an unknown event type", async () => {
    const source = await openSession();
    source.onmessage?.({ data: "not json at all" });
    source.emit({ type: "something-new", seq: 4 });
    // A frame we cannot read is not worth tearing the stream down over.
    expect(useWebmcpInspectorStore.getState().session?.sessionId).toBe(
      "session-1",
    );
  });

  it("surfaces a coded error when the session will not start", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ error: "no display here", code: "no-display" }),
        { status: 503 },
      ),
    );
    await useWebmcpInspectorStore.getState().startSession("https://shop.test/");

    const state = useWebmcpInspectorStore.getState();
    expect(state.starting).toBe(false);
    expect(state.session).toBeUndefined();
    expect(state.error).toMatchObject({
      message: "no display here",
      code: "no-display",
    });
  });

  it("reports a failed close so the browser is not silently stranded", async () => {
    await openSession();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "could not close" }), {
        status: 500,
      }),
    );
    await useWebmcpInspectorStore.getState().closeSession();
    // The session is already cleared from the UI, so a swallowed failure would
    // leave a window open with no "Close browser" button left to try again.
    expect(useWebmcpInspectorStore.getState().error?.message).toBe(
      "could not close",
    );
  });

  it("resets the chat opt-in when the session closes", async () => {
    await openSession();
    useWebmcpInspectorStore.getState().setChatEnabled(true);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ closed: true }), { status: 200 }),
    );
    await useWebmcpInspectorStore.getState().closeSession();
    // Carrying the choice across sessions would grant a DIFFERENT site's tools
    // to chat without anyone deciding so.
    expect(useWebmcpInspectorStore.getState().chatEnabled).toBe(false);
  });

  it("resolves an invocation whose settle beat the invoke response", async () => {
    const source = await openSession();
    // The POST answers with the id, and the settle arrives on the stream
    // before the caller can park on it — a fast tool always races this way.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      source.emit(activityEvent(settled("a2", "inv-1"), 2));
      return new Response(JSON.stringify({ invokeId: "inv-1" }), {
        status: 202,
      });
    });

    // Without the early-settle cache this would sit out the 90s timeout and
    // then report a failure for a tool that succeeded.
    await expect(
      useWebmcpInspectorStore.getState().invokeToolForResult(TOOL.toolKey, {}),
    ).resolves.toMatchObject({ state: "succeeded", output: "ok" });
  });

  it("settles callers waiting on a session that closes underneath them", async () => {
    await openSession();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ invokeId: "inv-9" }), { status: 202 }),
    );
    const pending = useWebmcpInspectorStore
      .getState()
      .invokeToolForResult(TOOL.toolKey, {});
    // Give the invoke a turn to park on its waiter before the session goes.
    await Promise.resolve();

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ closed: true }), { status: 200 }),
    );
    await useWebmcpInspectorStore.getState().closeSession();

    // A model turn must not block for the full timeout on a browser that has
    // already gone away.
    await expect(pending).resolves.toMatchObject({ state: "failed" });
  });

  it("settles waiters when the server reports the session is gone", async () => {
    const source = await openSession();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ invokeId: "inv-7" }), { status: 202 }),
    );
    const pending = useWebmcpInspectorStore
      .getState()
      .invokeToolForResult(TOOL.toolKey, {});
    await Promise.resolve();

    source.emit({ type: "session_gone", error: "That session is gone." });
    await expect(pending).resolves.toMatchObject({ state: "failed" });
  });

  it("does not hand one session's cached result to the next", async () => {
    const source = await openSession();
    source.emit(activityEvent(settled("a2", "inv-1"), 2));

    await openSession();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ invokeId: "inv-1" }), { status: 202 }),
    );
    const pending = useWebmcpInspectorStore
      .getState()
      .invokeToolForResult(TOOL.toolKey, {});

    // The id repeats across sessions in this test on purpose: a cache that
    // survived would resolve the new call with the old page's answer.
    const settledFirst = await Promise.race([
      pending.then(() => "settled" as const),
      Promise.resolve("still-waiting" as const),
    ]);
    expect(settledFirst).toBe("still-waiting");
  });

  it("handles an empty tool set", async () => {
    const source = await openSession();
    source.emit({ type: "tools", seq: 2, tools: [TOOL] });
    source.emit({ type: "tools", seq: 3, tools: [] });
    expect(useWebmcpInspectorStore.getState().tools).toEqual([]);
  });

  it("keeps the newest frame, and keeps it out of the timeline", async () => {
    const source = await openSession();
    source.emit({
      type: "frame",
      seq: 2,
      frame: { data: "one", deviceWidth: 1280, deviceHeight: 800, ts: 1 },
    });
    source.emit({
      type: "frame",
      seq: 3,
      frame: { data: "two", deviceWidth: 640, deviceHeight: 400, ts: 2 },
    });

    const state = useWebmcpInspectorStore.getState();
    expect(state.liveFrame).toMatchObject({
      src: "data:image/jpeg;base64,two",
      deviceWidth: 640,
      seq: 3,
    });
    // Frames are transient. The timeline is what the session exists to
    // produce, and it must not turn into a filmstrip.
    expect(state.activity).toEqual([]);
  });

  it("keeps the live frame separate from the manual screenshot", async () => {
    const source = await openSession();
    useWebmcpInspectorStore.setState({ lastScreenshot: "manual-capture" });
    source.emit({
      type: "frame",
      seq: 2,
      frame: { data: "paint", deviceWidth: 1280, deviceHeight: 800, ts: 1 },
    });
    // Two slots on purpose: one is the live picture, the other a snapshot
    // someone asked for. Collapsing them would make the invoke pane's thumbnail
    // flicker with every paint.
    const state = useWebmcpInspectorStore.getState();
    expect(state.lastScreenshot).toBe("manual-capture");
    expect(state.liveFrame?.src).toBe("data:image/jpeg;base64,paint");
  });

  it("ignores an event type it does not know, without losing the stream", async () => {
    const source = await openSession();
    source.emit({ type: "invented_later", seq: 2, payload: { a: 1 } });
    // The old shape fell through to the activity branch for anything that was
    // not `session` or `tools`, so a newer server's first new event type threw
    // on `event.entry` — swallowed by onmessage's catch, which turns "your
    // client is older than your server" into an unexplained gap.
    source.emit({ type: "tools", seq: 3, tools: [TOOL] });
    expect(useWebmcpInspectorStore.getState().tools).toHaveLength(1);
    expect(useWebmcpInspectorStore.getState().activity).toEqual([]);
  });

  it("drops the live frame when the session goes away", async () => {
    const source = await openSession();
    source.emit({
      type: "frame",
      seq: 2,
      frame: { data: "paint", deviceWidth: 1280, deviceHeight: 800, ts: 1 },
    });
    source.emit({ type: "session_gone", error: "That session is gone." });
    // Nothing is going to correct that picture now, so showing it would be a
    // page the viewer believes is current and is not.
    expect(useWebmcpInspectorStore.getState().liveFrame).toBeUndefined();
  });

  it("reports an old server's 400 as a screencast the client must fall back from", async () => {
    await openSession();
    useWebmcpInspectorStore.setState({
      liveFrame: liveFrame("paint"),
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Invalid command." }), {
        status: 400,
      }),
    );

    const accepted = await useWebmcpInspectorStore
      .getState()
      .setScreencast(true);

    expect(accepted).toBe(false);
    expect(useWebmcpInspectorStore.getState().liveFrame).toBeUndefined();
    // NOT surfaced in the error banner: the pane is about to start working via
    // the poll fallback, and "Invalid command." in front of someone whose
    // server is simply older is a bug report we would rather not receive.
    expect(useWebmcpInspectorStore.getState().error).toBeUndefined();
  });

  it("reports frames flowing, and clears the frame when they stop", async () => {
    await openSession();
    // `mockImplementation`, not `mockResolvedValue`: a Response body can only be
    // read once, so a single shared instance makes the SECOND call here look
    // like an empty body.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const { enabled } = JSON.parse(String((init as RequestInit)?.body));
      return new Response(JSON.stringify({ ok: true, streaming: enabled }), {
        status: 200,
      });
    });
    expect(await useWebmcpInspectorStore.getState().setScreencast(true)).toBe(
      true,
    );

    useWebmcpInspectorStore.setState({
      liveFrame: liveFrame("paint"),
    });
    // False after a stop is the honest answer: nothing is flowing now.
    expect(await useWebmcpInspectorStore.getState().setScreencast(false)).toBe(
      false,
    );
    expect(useWebmcpInspectorStore.getState().liveFrame).toBeUndefined();
  });

  it("omits display entirely for a window session", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(SESSION), { status: 201 }),
      );
    await useWebmcpInspectorStore.getState().startSession("https://shop.test/");

    const body = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));
    // Left OFF the request, not sent as "window": an older server that strips
    // the unknown field lands on exactly the behaviour it would have chosen.
    expect(body).toEqual({ url: "https://shop.test/" });
  });

  it("asks for an in-app session when the caller says so", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(SESSION), { status: 201 }),
      );
    await useWebmcpInspectorStore
      .getState()
      .startSession("https://shop.test/", { display: "in-app" });

    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toEqual({
      url: "https://shop.test/",
      display: "in-app",
    });
  });

  it("carries a mounted surface's id, and omits the field without one", async () => {
    // `mockImplementation`, not `mockResolvedValue`, for the reason the frames
    // test above spells out: a Response body reads once, so a shared instance
    // would leave the SECOND start with an empty body and a `{}` session —
    // and this test would still pass, because it reads the request bodies
    // rather than the sessions they produced.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () => new Response(JSON.stringify(SESSION), { status: 201 }),
      );
    await useWebmcpInspectorStore
      .getState()
      .startSession("https://shop.test/", {
        display: "in-app",
        webContentsId: 7,
      });
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toEqual({
      url: "https://shop.test/",
      display: "in-app",
      webContentsId: 7,
    });
    expect(useWebmcpInspectorStore.getState().session).toEqual(SESSION);

    await useWebmcpInspectorStore
      .getState()
      .startSession("https://shop.test/", { display: "in-app" });
    // Omitted, not sent as null or 0: an older server strips the unknown field
    // and starts an ordinary in-app session, which is the graceful degrade.
    expect(JSON.parse(String(fetchSpy.mock.calls[1][1]?.body))).toEqual({
      url: "https://shop.test/",
      display: "in-app",
    });
    // The half the body-sharing bug hid: the second start produced a real
    // session, not the `{}` an unreadable body would have left behind.
    expect(useWebmcpInspectorStore.getState().session).toEqual(SESSION);
  });

  it("tells the server the viewer's pixel ratio, and only for an in-app session", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () => new Response(JSON.stringify(SESSION), { status: 201 }),
      );
    const original = window.devicePixelRatio;
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: 2,
    });
    try {
      await useWebmcpInspectorStore
        .getState()
        .startSession("https://shop.test/", { display: "in-app" });
      // The browser runs headless on the server, with no display to ask.
      expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toEqual({
        url: "https://shop.test/",
        display: "in-app",
        devicePixelRatio: 2,
      });

      // A window session paints on a real display that already knows its own
      // ratio, so the field is left off entirely.
      await useWebmcpInspectorStore
        .getState()
        .startSession("https://shop.test/");
      expect(JSON.parse(String(fetchSpy.mock.calls[1][1]?.body))).toEqual({
        url: "https://shop.test/",
      });

      Object.defineProperty(window, "devicePixelRatio", {
        configurable: true,
        value: 1,
      });
      await useWebmcpInspectorStore
        .getState()
        .startSession("https://shop.test/", { display: "in-app" });
      // Omitted at 1: the server's own default, so the common case puts
      // nothing new on the wire and an older server strips nothing.
      expect(JSON.parse(String(fetchSpy.mock.calls[2][1]?.body))).toEqual({
        url: "https://shop.test/",
        display: "in-app",
      });
    } finally {
      Object.defineProperty(window, "devicePixelRatio", {
        configurable: true,
        value: original,
      });
    }
  });

  it("sends an input batch as one command, and nothing for an empty one", async () => {
    await openSession();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

    await useWebmcpInspectorStore.getState().sendInput([]);
    expect(fetchSpy).not.toHaveBeenCalled();

    await useWebmcpInspectorStore
      .getState()
      .sendInput([{ kind: "mouse_move", x: 1, y: 2 }]);
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toEqual({
      type: "input",
      events: [{ kind: "mouse_move", x: 1, y: 2 }],
    });
  });

  it("treats a 200 with streaming:false as a screencast to fall back from", async () => {
    await openSession();
    useWebmcpInspectorStore.setState({
      liveFrame: liveFrame("paint"),
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, streaming: false }), {
        status: 200,
      }),
    );

    // The server understood the command and the browser still cannot stream.
    // Reading only the status here would leave the pane waiting for frames that
    // are never coming.
    expect(await useWebmcpInspectorStore.getState().setScreencast(true)).toBe(
      false,
    );
    expect(useWebmcpInspectorStore.getState().liveFrame).toBeUndefined();
  });

  it("does not carry one session's screenshot into the next", async () => {
    await openSession();
    useWebmcpInspectorStore.setState({ lastScreenshot: "first-site" });

    await useWebmcpInspectorStore.getState().closeSession();
    // The pane falls back to this before the first frame arrives, so keeping it
    // would present the previous site's capture as the new session's live view.
    expect(useWebmcpInspectorStore.getState().lastScreenshot).toBeUndefined();

    useWebmcpInspectorStore.setState({ lastScreenshot: "stale" });
    await openSession();
    expect(useWebmcpInspectorStore.getState().lastScreenshot).toBeUndefined();
  });

  it("does not let the background screenshot poll clear an error banner", async () => {
    await openSession();
    useWebmcpInspectorStore.setState({
      error: { message: "That page could not be reached." },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ screenshotBase64: "shot" }), {
        status: 200,
      }),
    );

    await useWebmcpInspectorStore
      .getState()
      .captureScreenshot({ silent: true });
    expect(useWebmcpInspectorStore.getState().lastScreenshot).toBe("shot");
    // The poll runs once a second. Clearing here would wipe a navigation or
    // invocation failure within a second of it appearing — usually before
    // anyone had read it.
    expect(useWebmcpInspectorStore.getState().error?.message).toBe(
      "That page could not be reached.",
    );

    // The MANUAL button still clears it: that is a person acting on the banner.
    await useWebmcpInspectorStore.getState().captureScreenshot();
    expect(useWebmcpInspectorStore.getState().error).toBeUndefined();
  });

  it("does not land a poll's screenshot in the session that replaced it", async () => {
    await openSession();
    const { fetchSpy, release } = deferredFetch();

    const polling = useWebmcpInspectorStore
      .getState()
      .captureScreenshot({ silent: true });
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    // The poll runs once a second and its request outlives a close, so the
    // session turning over underneath one is routine, not exotic.
    useWebmcpInspectorStore.setState({
      session: { ...SESSION, sessionId: "session-2" },
    });
    release(
      new Response(JSON.stringify({ screenshotBase64: "old-site" }), {
        status: 200,
      }),
    );
    await polling;

    // The pane falls back to `lastScreenshot` before its first frame, so this
    // would hang the PREVIOUS page's paint in the new session's live view —
    // where no later poll would correct it, because it is not stale, it is
    // simply the wrong page.
    expect(useWebmcpInspectorStore.getState().lastScreenshot).toBeUndefined();
  });

  it("does not clear the next session's frame when a stale toggle is refused", async () => {
    await openSession();
    const { fetchSpy, release } = deferredFetch();

    const toggling = useWebmcpInspectorStore.getState().setScreencast(true);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    useWebmcpInspectorStore.setState({
      session: { ...SESSION, sessionId: "session-2" },
      liveFrame: liveFrame("fresh"),
    });
    release(
      new Response(JSON.stringify({ error: "Invalid command." }), {
        status: 400,
      }),
    );
    expect(await toggling).toBe(false);

    // The refusal belongs to the session that asked. Acting on it here would
    // blank a pane that is streaming perfectly well, and nothing would repaint
    // it until the page next changed on its own.
    expect(useWebmcpInspectorStore.getState().liveFrame?.src).toBe(
      "data:image/jpeg;base64,fresh",
    );
  });

  it("splits an input batch past the route's cap, in order", async () => {
    await openSession();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

    const events = Array.from({ length: 70 }, (_, i) => ({
      kind: "mouse_move" as const,
      x: i,
      y: 0,
    }));
    await useWebmcpInspectorStore.getState().sendInput(events);

    // Sent whole it would be refused and the gesture lost entirely.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const sent = fetchSpy.mock.calls.flatMap(
      (call) => JSON.parse(String(call[1]?.body)).events,
    );
    expect(sent).toHaveLength(70);
    expect(sent.map((event: { x: number }) => event.x)).toEqual(
      events.map((event) => event.x),
    );
  });

  it("does not let a slow older capture land on top of a newer one", async () => {
    await openSession();
    const releases: Array<(response: Response) => void> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          releases.push(resolve);
        }),
    );

    // Two captures in flight at once — routine, because the poll keeps its
    // once-a-second cadence rather than queueing behind a slow capture.
    const first = useWebmcpInspectorStore
      .getState()
      .captureScreenshot({ silent: true });
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const second = useWebmcpInspectorStore
      .getState()
      .captureScreenshot({ silent: true });
    await vi.waitFor(() => expect(releases).toHaveLength(2));

    // The NEWER one answers first…
    releases[1](
      new Response(JSON.stringify({ screenshotBase64: "newer" }), {
        status: 200,
      }),
    );
    await second;
    expect(useWebmcpInspectorStore.getState().lastScreenshot).toBe("newer");

    // …and the older one answers after it.
    releases[0](
      new Response(JSON.stringify({ screenshotBase64: "older" }), {
        status: 200,
      }),
    );
    await first;
    // Applying it would step the pane backwards a frame, and a manual capture
    // someone just asked for is exactly what a slow poll would overwrite.
    expect(useWebmcpInspectorStore.getState().lastScreenshot).toBe("newer");
  });

  it("lets an older capture through when the newer one failed", async () => {
    await openSession();
    const releases: Array<(response: Response) => void> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          releases.push(resolve);
        }),
    );

    const first = useWebmcpInspectorStore
      .getState()
      .captureScreenshot({ silent: true });
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const second = useWebmcpInspectorStore
      .getState()
      .captureScreenshot({ silent: true });
    await vi.waitFor(() => expect(releases).toHaveLength(2));

    // The newer capture FAILS — a poll hitting a blip, which is why the poll
    // exists once a second rather than once.
    releases[1](new Response("{}", { status: 500 }));
    await second;
    releases[0](
      new Response(JSON.stringify({ screenshotBase64: "older" }), {
        status: 200,
      }),
    );
    await first;

    // A failed capture that claimed the slot on its way to writing nothing
    // would reject this one too, and a single transient blip would strand the
    // pane on whatever it was showing before either request.
    expect(useWebmcpInspectorStore.getState().lastScreenshot).toBe("older");
  });

  it("abandons the rest of a split gesture when the session turns over", async () => {
    await openSession();
    const bodies: string[] = [];
    let release!: (response: Response) => void;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      bodies.push(String((init as RequestInit)?.body));
      // Only the FIRST request is held; the rest would answer immediately.
      if (bodies.length > 1) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });

    const sending = useWebmcpInspectorStore.getState().sendInput(
      Array.from({ length: 70 }, (_, i) => ({
        kind: "mouse_move" as const,
        x: i,
        y: 0,
      })),
    );
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    // The session turns over between the two halves of one gesture.
    useWebmcpInspectorStore.setState({
      session: { ...SESSION, sessionId: "session-2" },
    });
    release(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await sending;

    // The guard has to run per BATCH, not once before the loop: a gesture past
    // the route's cap is more than one request, and the tail landing on
    // whichever page replaced this one is a click going somewhere nobody aimed.
    expect(bodies).toHaveLength(1);
  });

  it("serializes overlapping commands so a release cannot precede its press", async () => {
    await openSession();
    const order: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit)?.body));
      order.push(body.events?.[0]?.kind ?? body.type);
      // The first request answers SLOWLY. Unserialized, the second would reach
      // the handler first and the page would see a release with no press.
      const delay = order.length === 1 ? 20 : 0;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const store = useWebmcpInspectorStore.getState();
    const first = store.sendInput([
      { kind: "mouse_down", x: 1, y: 1, button: "left" },
    ]);
    const second = store.sendInput([
      { kind: "mouse_up", x: 1, y: 1, button: "left" },
    ]);
    await Promise.all([first, second]);

    expect(order).toEqual(["mouse_down", "mouse_up"]);
  });

  it("drops input queued for a session that has since been replaced", async () => {
    await openSession();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bodies: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      bodies.push(String((init as RequestInit)?.body));
      // The first command hangs, holding the queue open across the swap below.
      if (bodies.length === 1) await gate;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const store = useWebmcpInspectorStore.getState();
    const first = store.sendInput([{ kind: "mouse_move", x: 1, y: 1 }]);
    // Let the first command actually reach `fetch` and hang there, so the
    // second is genuinely QUEUED behind it rather than merely scheduled.
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    const queued = store.sendInput([
      { kind: "mouse_down", x: 2, y: 2, button: "left" },
    ]);

    // The session is replaced while that second batch waits its turn.
    useWebmcpInspectorStore.setState({
      session: { ...SESSION, sessionId: "session-2" },
    });
    release();
    await Promise.all([first, queued]);

    // A click aimed at one page landing on the next one is worse than a click
    // that goes nowhere.
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]).events[0].kind).toBe("mouse_move");
  });

  it("does not ask for a screencast with no session open", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await useWebmcpInspectorStore.getState().setScreencast(true)).toBe(
      false,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/**
 * The frame transport ladder.
 *
 * The pane must keep painting through every way the binary socket can fail —
 * a server too old to serve the route, a drop mid-session, auth going away —
 * and must never paint the WRONG thing: an old frame over a newer one, or a
 * previous session's frame into the current session's pane. Those are the two
 * failure modes worth pinning, and both are invisible in a happy-path test.
 */
describe("webmcp inspector store — frame transport", () => {
  let urls: string[] = [];

  beforeEach(() => {
    useWebmcpInspectorStore.getState().disconnect();
    FakeEventSource.instances = [];
    FakeWebSocket.instances = [];
    (
      window as unknown as { __MCP_SESSION_TOKEN__?: string }
    ).__MCP_SESSION_TOKEN__ = "test-token";
    urls = [];
    setFramePresenterForTests(
      createFramePresenter({
        createUrl: () => {
          const url = `blob:frame-${urls.length}`;
          urls.push(url);
          return url;
        },
        revokeUrl: () => {},
        defer: (fn) => fn(),
      }),
    );
    vi.restoreAllMocks();
    useWebmcpInspectorStore.setState({
      session: undefined,
      tools: [],
      activity: [],
      pending: [],
      starting: false,
      error: undefined,
      liveFrame: undefined,
      frameTransport: { rung: "none", attempts: 0, latched: false },
      lastScreenshot: undefined,
      chatEnabled: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens the socket and takes frames off SSE, for a frame-stream session", async () => {
    const { sse, ws } = await openFrameSession();

    // Frames move to the socket, so SSE is told not to send them — from
    // connect time, not after the first one arrives.
    expect(sse.url).toContain("frames=off");
    expect(ws.url).toBe(
      "ws://localhost:3000/api/web/webmcp/sessions/session-1/frames",
    );
    // The token rides the subprotocol so it never lands in an access log.
    expect(ws.protocols).toEqual(["test-token"]);
    expect(ws.binaryType).toBe("arraybuffer");
  });

  it("opens no socket, and no frames param, for any other session", async () => {
    // A native-window session drives a real browser the person is looking at,
    // and a hosted one paints in a datacenter. Neither has pixels to carry.
    const sse = await openSession();
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(sse.url).not.toContain("frames=");
  });

  it("stays on SSE frames when there is no token to open the socket with", async () => {
    // The token IS the auth on that socket, so without one the handshake could
    // only ever be refused — and an empty subprotocol entry is a constructor
    // SyntaxError rather than a close code, so "just try it" would throw out
    // of `connect()` and take the SSE stream with it.
    // The real token is cached in its own module for the tab's lifetime, so
    // clearing `window` is not enough — this asks the question the store asks.
    vi.spyOn(sessionToken, "hasSessionToken").mockReturnValue(false);
    const { sse } = await openFrameSession();
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(sse.url).not.toContain("frames=off");

    sse.emit({
      type: "frame",
      seq: 2,
      frame: { data: "paint", deviceWidth: 1280, deviceHeight: 800, ts: 1 },
    });
    expect(useWebmcpInspectorStore.getState().liveFrame?.src).toBe(
      "data:image/jpeg;base64,paint",
    );
  });

  it("renders a binary frame as a blob URL with its own metadata", async () => {
    const { ws } = await openFrameSession();
    ws.open();
    ws.emitFrame(binaryFrame(7, { deviceWidth: 1024, deviceHeight: 640 }));

    expect(useWebmcpInspectorStore.getState().liveFrame).toEqual({
      src: "blob:frame-0",
      deviceWidth: 1024,
      deviceHeight: 640,
      cssWidth: 1024,
      cssHeight: 640,
      ts: 5_000,
      seq: 7,
    });
  });

  it("reports a scaled frame's CSS size, so clicks stay in the page's units", async () => {
    const { ws } = await openFrameSession();
    ws.open();
    ws.emitFrame(
      binaryFrame(7, { deviceWidth: 2560, deviceHeight: 1600, scale: 2 }),
    );

    const frame = useWebmcpInspectorStore.getState().liveFrame;
    // The picture is 2560 pixels wide and the page is 1280 CSS pixels wide.
    // Scaling a click against the former sends it to twice the coordinate the
    // person pointed at.
    expect(frame).toMatchObject({
      deviceWidth: 2560,
      deviceHeight: 1600,
      cssWidth: 1280,
      cssHeight: 800,
    });
  });

  it("reads a missing or nonsense scale as 1", async () => {
    const { sse, ws } = await openFrameSession();
    ws.open();
    // No scale at all: every server older than the field, and every provider
    // that does not capture above CSS resolution.
    ws.emitFrame(binaryFrame(7, { deviceWidth: 1280, deviceHeight: 800 }));
    expect(useWebmcpInspectorStore.getState().liveFrame).toMatchObject({
      cssWidth: 1280,
      cssHeight: 800,
    });

    // Zero would divide the geometry into infinity and put the pane's box
    // somewhere no click could reach.
    ws.emitFrame(
      binaryFrame(8, { deviceWidth: 1280, deviceHeight: 800, scale: 0 }),
    );
    expect(useWebmcpInspectorStore.getState().liveFrame).toMatchObject({
      cssWidth: 1280,
      cssHeight: 800,
    });

    sse.emit({
      type: "frame",
      seq: 9,
      frame: { data: "paint", deviceWidth: 1280, deviceHeight: 800, ts: 1 },
    });
    expect(useWebmcpInspectorStore.getState().liveFrame).toMatchObject({
      src: "data:image/jpeg;base64,paint",
      cssWidth: 1280,
      cssHeight: 800,
    });
  });

  it("drops an out-of-order frame on the socket too", async () => {
    const { ws } = await openFrameSession();
    ws.open();
    ws.emitFrame(binaryFrame(10));
    // The guard is on BOTH paths, not just the SSE one: a replayed frame on a
    // reconnected socket can be older than what the previous socket already
    // delivered, and painting it would move the pane backwards.
    ws.emitFrame(binaryFrame(9, { ts: 1 }));
    expect(useWebmcpInspectorStore.getState().liveFrame?.seq).toBe(10);
    ws.emitFrame(binaryFrame(10, { ts: 2 }));
    expect(useWebmcpInspectorStore.getState().liveFrame?.ts).toBe(5_000);

    ws.emitFrame(binaryFrame(11, { ts: 3 }));
    expect(useWebmcpInspectorStore.getState().liveFrame?.seq).toBe(11);
  });

  it("drops a straggling SSE frame that predates the socket's newest", async () => {
    const { sse, ws } = await openFrameSession();
    ws.open();
    ws.emitFrame(binaryFrame(10));
    // The exact overlap the ladder creates: SSE frames are flipped back on
    // while a frame from the socket is already on screen. Painting the older
    // one would drag the pane backwards, with nothing to correct it.
    sse.emit({
      type: "frame",
      seq: 9,
      frame: { data: "older", deviceWidth: 1280, deviceHeight: 800, ts: 1 },
    });

    expect(useWebmcpInspectorStore.getState().liveFrame?.seq).toBe(10);
    expect(useWebmcpInspectorStore.getState().liveFrame?.src).toBe(
      "blob:frame-0",
    );

    // …and a NEWER SSE frame is still accepted, which is what makes the
    // fallback work at all.
    sse.emit({
      type: "frame",
      seq: 11,
      frame: { data: "newer", deviceWidth: 1280, deviceHeight: 800, ts: 2 },
    });
    expect(useWebmcpInspectorStore.getState().liveFrame?.src).toBe(
      "data:image/jpeg;base64,newer",
    );
  });

  it("reports the socket once it is open, and nothing before that", async () => {
    const transport = () => useWebmcpInspectorStore.getState().frameTransport;
    const { ws } = await openFrameSession();
    // One attempt spent, nothing carrying pixels yet: the handshake is still
    // in flight and SSE has already been told to stop sending frames.
    expect(transport()).toEqual({ rung: "none", attempts: 1, latched: false });

    ws.open();
    expect(transport()).toEqual({ rung: "ws", attempts: 0, latched: false });

    useWebmcpInspectorStore.getState().disconnect();
    // A teardown is not a degradation: the counters go back to where a fresh
    // session starts, so the next one is not described by the last one's
    // failures.
    expect(transport()).toEqual({ rung: "none", attempts: 0, latched: false });
  });

  it("counts the ladder's attempts, and says when it has given up", async () => {
    vi.useFakeTimers();
    const transport = () => useWebmcpInspectorStore.getState().frameTransport;
    const { ws } = await openFrameSession();

    // 1006 — an old server's 404 upgrade. Frames move back to SSE at once and
    // the ladder starts retrying: degraded, but NOT settled, so nothing should
    // be telling the person about it yet.
    ws.emitClose(1006);
    expect(transport()).toMatchObject({ rung: "sse-frames", latched: false });

    for (const [attempt, delay] of [
      [2, 500],
      [3, 1_000],
      [4, 2_000],
    ] as const) {
      vi.advanceTimersByTime(delay);
      expect(transport().attempts).toBe(attempt);
      FakeWebSocket.instances.at(-1)!.emitClose(1006);
    }

    // The fourth failure exhausts the ladder. THIS is the state worth showing:
    // the pane is on the slower path and nothing will move it back for the
    // rest of the session.
    expect(transport()).toEqual({
      rung: "sse-frames",
      attempts: 4,
      latched: true,
    });
  });

  it("latches without retrying when the socket is refused outright", async () => {
    const { ws } = await openFrameSession();
    // 4401/4503: auth, or the feature switched off. Retrying cannot fix
    // either, so the ladder stops here rather than spending its budget.
    ws.emitClose(4401);
    expect(useWebmcpInspectorStore.getState().frameTransport).toEqual({
      rung: "sse-frames",
      attempts: 1,
      latched: true,
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("reports the screenshot poll as the transport it is", async () => {
    const { ws } = await openFrameSession();
    ws.open();
    useWebmcpInspectorStore.getState().noteScreenshotPolling(true);
    // A server too old to screencast at all. Whatever the socket ladder is
    // doing, what is on screen came from a screenshot.
    expect(useWebmcpInspectorStore.getState().frameTransport.rung).toBe("poll");

    useWebmcpInspectorStore.getState().noteScreenshotPolling(false);
    expect(useWebmcpInspectorStore.getState().frameTransport.rung).toBe("ws");
  });

  it("puts frames back on SSE at once, then retries three times and latches", async () => {
    vi.useFakeTimers();
    const { ws } = await openFrameSession();
    expect(FakeEventSource.instances.at(-1)!.url).toContain("frames=off");

    // 1006 is what an old server's 404 upgrade looks like from here.
    ws.emitClose(1006);
    // Immediately, not after the ladder: a pane blank for two and a half
    // seconds would be a worse regression than the lag being fixed.
    expect(FakeEventSource.instances.at(-1)!.url).not.toContain("frames=off");
    expect(FakeWebSocket.instances).toHaveLength(1);

    for (const [attempt, delay] of [
      [2, 500],
      [3, 1_000],
      [4, 2_000],
    ] as const) {
      vi.advanceTimersByTime(delay - 1);
      expect(FakeWebSocket.instances).toHaveLength(attempt - 1);
      vi.advanceTimersByTime(1);
      expect(FakeWebSocket.instances).toHaveLength(attempt);
      FakeWebSocket.instances.at(-1)!.emitClose(1006);
    }

    // FOUR attempts total, then never again for this session: the failure this
    // ladder is really for is structural, and a socket churning forever behind
    // a pane that works fine on SSE helps nobody.
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it("returns the retry budget after a socket opens", async () => {
    vi.useFakeTimers();
    const { ws } = await openFrameSession();

    // Three drops spread across a long session, each reconnecting fine.
    let current = ws;
    for (let i = 0; i < 3; i += 1) {
      current.emitClose(1006);
      vi.advanceTimersByTime(500);
      current = FakeWebSocket.instances.at(-1)!;
      current.open();
    }
    expect(FakeWebSocket.instances).toHaveLength(4);

    // Without the reset, the fourth close would exhaust a budget meant for the
    // structural case and latch a session that has been working all along —
    // reverting it to the SSE latency this change exists to remove.
    current.emitClose(1006);
    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.instances).toHaveLength(5);
    FakeWebSocket.instances.at(-1)!.open();
  });

  it("still latches after four failures with no successful open between them", async () => {
    vi.useFakeTimers();
    const { ws } = await openFrameSession();
    // The bound the reset must not weaken: a server too old to serve the route
    // answers 1006 every time and never opens, so the ladder still stops.
    ws.emitClose(1006);
    for (const delay of [500, 1_000, 2_000]) {
      vi.advanceTimersByTime(delay);
      FakeWebSocket.instances.at(-1)!.emitClose(1006);
    }
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it("flips SSE back to frames=off when a retry succeeds", async () => {
    vi.useFakeTimers();
    const { ws } = await openFrameSession();
    ws.emitClose(1006);
    expect(FakeEventSource.instances.at(-1)!.url).not.toContain("frames=off");

    vi.advanceTimersByTime(500);
    const retried = FakeWebSocket.instances.at(-1)!;
    retried.open();
    expect(FakeEventSource.instances.at(-1)!.url).toContain("frames=off");

    retried.emitFrame(binaryFrame(3));
    expect(useWebmcpInspectorStore.getState().liveFrame?.seq).toBe(3);
  });

  it("does not reset the seq guard or the frame across an SSE flip", async () => {
    vi.useFakeTimers();
    const { ws } = await openFrameSession();
    ws.open();
    ws.emitFrame(binaryFrame(12));
    const before = useWebmcpInspectorStore.getState().liveFrame;

    ws.emitClose(1006);

    // Reset #1: replacing the EventSource touches NOTHING. A transient flip
    // that blanked the pane — or that revoked the blob it is painted from —
    // would make the ladder visible as a flicker.
    expect(useWebmcpInspectorStore.getState().liveFrame).toBe(before);
    FakeEventSource.instances.at(-1)!.emit({
      type: "frame",
      seq: 11,
      frame: { data: "stale", deviceWidth: 1280, deviceHeight: 800, ts: 1 },
    });
    expect(useWebmcpInspectorStore.getState().liveFrame).toBe(before);
  });

  it("does not retry or flip SSE on 4404 or 1000", async () => {
    vi.useFakeTimers();
    for (const code of [4404, 1000]) {
      FakeWebSocket.instances = [];
      FakeEventSource.instances = [];
      const { ws } = await openFrameSession(`session-${code}`);
      ws.emitClose(code);

      // The session is over, or we asked for this. The SSE stream carries the
      // story either way, and there is nothing left to stream.
      expect(FakeEventSource.instances.at(-1)!.url, String(code)).toContain(
        "frames=off",
      );
      vi.advanceTimersByTime(60_000);
      expect(FakeWebSocket.instances, String(code)).toHaveLength(1);
    }
  });

  it("falls back to SSE frames without retrying on 4401 and 4503", async () => {
    vi.useFakeTimers();
    for (const code of [4401, 4503]) {
      FakeWebSocket.instances = [];
      FakeEventSource.instances = [];
      const { ws } = await openFrameSession(`session-${code}`);
      ws.emitClose(code);

      // Auth, or the feature being off, is not something a retry fixes — but
      // the pane still has to show the page.
      expect(FakeEventSource.instances.at(-1)!.url, String(code)).not.toContain(
        "frames=off",
      );
      vi.advanceTimersByTime(60_000);
      expect(FakeWebSocket.instances, String(code)).toHaveLength(1);
    }
  });

  it("lets no armed retry outlive the session it belongs to", async () => {
    vi.useFakeTimers();
    const { ws } = await openFrameSession("session-old");
    ws.emitClose(1006);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await openFrameSession("session-new");
    const newSocketCount = FakeWebSocket.instances.length;

    // Nothing is left armed…
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    // …and had one somehow fired, the generation it captured no longer
    // matches, so it could not have opened a socket for the dead session.
    expect(FakeWebSocket.instances).toHaveLength(newSocketCount);
  });

  it("lets a socket from a replaced session mutate nothing", async () => {
    vi.useFakeTimers();
    const { ws: stale } = await openFrameSession("session-old");
    stale.open();

    await openFrameSession("session-new");
    const current = FakeWebSocket.instances.at(-1)!;
    current.open();
    current.emitFrame(binaryFrame(4));
    const painted = useWebmcpInspectorStore.getState().liveFrame;

    // A message already dispatched when the session turned over, and a close
    // event racing our own close(). Both belong to a generation that is gone.
    stale.emitFrame(binaryFrame(99));
    stale.emitClose(1006);

    expect(useWebmcpInspectorStore.getState().liveFrame).toBe(painted);
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances.at(-1)).toBe(current);
  });

  it("ignores a text frame and drops one it cannot decode", async () => {
    const { ws } = await openFrameSession();
    ws.open();
    ws.emitFrame(binaryFrame(3));
    const painted = useWebmcpInspectorStore.getState().liveFrame;

    // A pong is control traffic, not a paint.
    expect(() =>
      ws.onmessage?.({ data: JSON.stringify({ type: "pong" }) }),
    ).not.toThrow();
    // And a truncated message is dropped rather than thrown: a throw in a
    // `message` handler takes the whole socket down over one bad paint.
    const encoded = encodeWebMcpBinaryFrame(binaryFrame(4));
    expect(() =>
      ws.onmessage?.({ data: encoded.buffer.slice(0, 12) }),
    ).not.toThrow();

    expect(useWebmcpInspectorStore.getState().liveFrame).toBe(painted);
  });

  it("pings while open, and stops once the socket closes", async () => {
    vi.useFakeTimers();
    const { ws } = await openFrameSession();
    ws.open();

    vi.advanceTimersByTime(30_000);
    expect(ws.sent).toEqual([JSON.stringify({ type: "ping" })]);

    // The keepalive is a timer on a socket that is gone otherwise — and on the
    // server it is also what refreshes the session's idle deadline, so a
    // stopped one is a session reaped under a pane nobody closed.
    ws.emitClose(1006);
    vi.advanceTimersByTime(120_000);
    expect(ws.sent).toHaveLength(1);
  });

  it("does NOT ping while the document is hidden, and resumes when it shows", async () => {
    vi.useFakeTimers();
    // Shadows the prototype getter; the delete in `finally` restores it.
    const setVisibility = (value: DocumentVisibilityState) =>
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => value,
      });
    try {
      setVisibility("hidden");
      const { ws } = await openFrameSession();
      ws.open();

      // The server refreshes the session's idle deadline on every ping, so a
      // hidden tab that kept pinging would hold the session — a real Chromium,
      // and one of the capacity slots — unreapable for as long as the tab
      // existed anywhere in the browser. Hidden already means "not watching"
      // to the rest of this feature: the pane stops the screencast on the very
      // same signal.
      vi.advanceTimersByTime(120_000);
      expect(ws.sent).toHaveLength(0);

      // The socket stayed open, so coming back needs no handshake and is at
      // most one interval from telling the server someone is watching again.
      setVisibility("visible");
      vi.advanceTimersByTime(30_000);
      expect(ws.sent).toEqual([JSON.stringify({ type: "ping" })]);
    } finally {
      delete (document as { visibilityState?: unknown }).visibilityState;
    }
  });

  it("clears the frame and its blob when the stream stops", async () => {
    const revokedUrls: string[] = [];
    setFramePresenterForTests(
      createFramePresenter({
        createUrl: () => "blob:only",
        revokeUrl: (url) => revokedUrls.push(url),
        defer: (fn) => fn(),
      }),
    );
    const { ws } = await openFrameSession();
    ws.open();
    ws.emitFrame(binaryFrame(2));

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, streaming: false }), {
        status: 200,
      }),
    );
    await useWebmcpInspectorStore.getState().setScreencast(false);

    // Reset #2: the picture is no longer current, so it goes — and the bytes
    // behind it go with it, after React has dropped the src.
    expect(useWebmcpInspectorStore.getState().liveFrame).toBeUndefined();
    expect(revokedUrls).toContain("blob:only");
    // The socket is NOT closed: a screencast toggle follows tab visibility,
    // and a handshake per flip is pure cost.
    expect(ws.closedByClient).toBe(false);
  });

  it("resets the seq guard on teardown, so the next session paints", async () => {
    const { ws } = await openFrameSession("session-old");
    ws.open();
    ws.emitFrame(binaryFrame(500));

    const { ws: next } = await openFrameSession("session-new");
    next.open();
    // A new session's counter starts at 1. A guard that survived teardown
    // would swallow every frame of it, and the pane would never paint again.
    next.emitFrame(binaryFrame(1));
    expect(useWebmcpInspectorStore.getState().liveFrame?.seq).toBe(1);
  });

  it("drops pending latency samples when the session is torn down", async () => {
    localStorage.setItem("webmcp:frame-stats", "1");
    resetFrameStatsFlagForTests();
    try {
      const { ws } = await openFrameSession("session-old");
      ws.open();
      ws.emitFrame(binaryFrame(2));
      // The gesture, as `sendInput` records it. Called directly rather than
      // through the pane, because the settling half (`notePainted`) is the
      // <img>'s `onLoad` and no pane is rendered here — what this test owns is
      // whether the store's TEARDOWN drops what is pending.
      noteInputSent(2);

      const { ws: next } = await openFrameSession("session-new");
      next.open();
      next.emitFrame(binaryFrame(9));

      // `seq` restarts per session, so without teardown clearing this, the
      // next page's ninth frame settles a gesture aimed at the previous page
      // and reports the gap between two unrelated sessions as latency.
      notePainted({ ts: Date.now(), seq: 9 });
      expect(frameStatsReport().inputToPaint.n).toBe(0);
    } finally {
      localStorage.removeItem("webmcp:frame-stats");
      resetFrameStatsFlagForTests();
    }
  });

  it("closes the socket and clears the frame when the session goes away", async () => {
    const { sse, ws } = await openFrameSession();
    ws.open();
    ws.emitFrame(binaryFrame(2));

    sse.emit({ type: "session_gone", error: "That session is gone." });
    expect(ws.closedByClient).toBe(true);
    expect(useWebmcpInspectorStore.getState().liveFrame).toBeUndefined();
  });

  it("tears the socket down on disconnect and rebuilds it on reconnect", async () => {
    const { ws } = await openFrameSession();
    ws.open();

    useWebmcpInspectorStore.getState().disconnect();
    expect(ws.closedByClient).toBe(true);

    useWebmcpInspectorStore.getState().reconnect();
    const resumed = FakeWebSocket.instances.at(-1)!;
    expect(resumed).not.toBe(ws);
    resumed.open();
    resumed.emitFrame(binaryFrame(1));
    expect(useWebmcpInspectorStore.getState().liveFrame?.seq).toBe(1);
  });
});
