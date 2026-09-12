/**
 * The store holds the surface's easiest-to-get-wrong logic: SSE frame parsing,
 * activity bookkeeping across reconnects, and pending-invocation state that
 * decides whether Invoke is disabled.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  useWebmcpInspectorStore,
  webmcpFrameChannel,
} from "../webmcp-inspector-store";
import * as sessionToken from "@/lib/session-token";
import {
  frameStatsReport,
  notePainted,
  noteInputSent,
  resetFrameStatsFlagForTests,
} from "@/lib/webmcp-inspector/frame-stats";
import {
  encodeFrameStreamRecord,
  FRAME_STREAM_KIND,
  type FrameStreamFrame,
} from "@/shared/browserd-frame-stream";
import type {
  WebMcpActivityEntry,
  WebMcpEvent,
  WebMcpSessionPublic,
  WebMcpToolDescriptor,
} from "@/shared/webmcp-inspector-protocol";

/**
 * Every bitmap the shared reader decoded, so a test can assert that the one a
 * frame replaced was released.
 *
 * jsdom has neither `createImageBitmap` nor `ImageBitmap`, and the reader the
 * socket now uses decodes through it — so this stands in for the browser's
 * image pipeline, and records the closes the pane's memory story depends on.
 */
interface FakeBitmap {
  closed: boolean;
  close(): void;
}
let bitmaps: FakeBitmap[] = [];
beforeEach(() => {
  bitmaps = [];
  vi.stubGlobal("createImageBitmap", async () => {
    const bitmap: FakeBitmap = {
      closed: false,
      close() {
        this.closed = true;
      },
    };
    bitmaps.push(bitmap);
    return bitmap;
  });
});

/**
 * Let the decode settle.
 *
 * `createImageBitmap` is a promise, so a frame pushed into the socket reaches
 * the channel a microtask later rather than synchronously. Two turns: one for
 * the decode, one for the `finally` that starts any pending record behind it.
 */
async function decoded(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * Let a socket the store has decided to open actually appear.
 *
 * `openFrameSocket` mints a single-use nonce first, so a timer that arms a
 * retry only STARTS the work — the `FakeWebSocket` lands a few microtasks
 * later, and fake timers do not advance those.
 */
async function socketOpened(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/** Captured EventSource instances, so a test can push frames at the store. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closed = false;
  controller?: ReadableStreamDefaultController<Uint8Array>;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
    try {
      this.controller?.close();
    } catch {}
  }
  async emit(payload: unknown) {
    this.controller?.enqueue(
      new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`),
    );
    this.onmessage?.({ data: JSON.stringify(payload) });
    await Promise.resolve();
    await Promise.resolve();
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

  /** Push one frame record and, by default, wait for its decode. */
  async emitFrame(
    frame: Omit<FrameStreamFrame, "kind" | "scale"> & { scale?: number },
    settle = true,
  ) {
    const encoded = encodeFrameStreamRecord({
      kind: FRAME_STREAM_KIND.frame,
      scale: 1,
      ...frame,
    });
    this.onmessage?.({
      data: encoded.buffer.slice(
        encoded.byteOffset,
        encoded.byteOffset + encoded.byteLength,
      ),
    });
    if (settle) await decoded();
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

function binaryFrame(
  seq: number,
  overrides: Partial<Omit<FrameStreamFrame, "kind">> = {},
) {
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

/** A picture already on screen, as the channel holds it. */
function paintChannel(seq = 2) {
  webmcpFrameChannel.publish({
    bitmap: undefined,
    data: "paint",
    deviceWidth: 1280,
    deviceHeight: 800,
    scale: 1,
    ts: 1,
    seq,
  });
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
  // The stream is a fetch body and the frame socket's nonce is a request, so
  // neither transport exists at the turn `startSession` resolves on.
  for (let i = 0; i < 20; i++) await Promise.resolve();
  return FakeEventSource.instances.at(-1)!;
}

/** Open a frame-stream session and hand back both of its transports. */
async function openFrameSession(sessionId = "session-1") {
  const sse = await openSession({ ...FRAME_SESSION, sessionId });
  return { sse, ws: FakeWebSocket.instances.at(-1)! };
}

describe("webmcp inspector store", () => {
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
    vi.restoreAllMocks();
    useWebmcpInspectorStore.setState({
      session: undefined,
      tools: [],
      activity: [],
      pending: [],
      starting: false,
      error: undefined,
      frameTransport: { rung: "none", attempts: 0, latched: false },
      lastScreenshot: undefined,
      chatEnabled: false,
    });
  });

  it("applies session, tools and activity frames", async () => {
    const source = await openSession();
    await source.emit({ type: "tools", seq: 2, tools: [TOOL] });
    await source.emit(activityEvent(started("a1", "inv-1"), 3));

    const state = useWebmcpInspectorStore.getState();
    expect(state.session?.sessionId).toBe("session-1");
    expect(state.tools).toHaveLength(1);
    expect(state.activity.map((entry) => entry.id)).toEqual(["a1"]);
    expect(state.pending.map((item) => item.invokeId)).toEqual(["inv-1"]);
  });

  it("clears pending once an invocation settles", async () => {
    const source = await openSession();
    await source.emit(activityEvent(started("a1", "inv-1")));
    await source.emit(activityEvent(settled("a2", "inv-1"), 2));
    expect(useWebmcpInspectorStore.getState().pending).toEqual([]);
  });

  it("ignores an activity entry it has already applied", async () => {
    const source = await openSession();
    await source.emit(activityEvent(started("a1", "inv-1")));
    await source.emit(activityEvent(settled("a2", "inv-1"), 2));
    // EventSource reconnects on its own and the server replays the ring, so the
    // same entries arrive again. Appending them would double the timeline, hand
    // React duplicate keys, and re-add a pending invocation that already
    // finished — leaving Invoke disabled forever.
    await source.emit(activityEvent(started("a1", "inv-1")));
    await source.emit(activityEvent(settled("a2", "inv-1"), 2));

    const state = useWebmcpInspectorStore.getState();
    expect(state.activity.map((entry) => entry.id)).toEqual(["a1", "a2"]);
    expect(state.pending).toEqual([]);
  });

  it("does not resurrect pending when only the start is replayed", async () => {
    const source = await openSession();
    await source.emit(activityEvent(started("a1", "inv-1")));
    await source.emit(activityEvent(settled("a2", "inv-1"), 2));
    // The settle has scrolled out of the replay window; only the start returns.
    await source.emit(activityEvent(started("a1", "inv-1")));
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
    await resumed.emit({ type: "tools", seq: 9, tools: [TOOL] });
    expect(useWebmcpInspectorStore.getState().tools).toHaveLength(1);
  });

  it("does nothing on reconnect when there is no session", () => {
    useWebmcpInspectorStore.getState().reconnect();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("refreshes tool metadata without navigating or invoking", async () => {
    useWebmcpInspectorStore.setState({ session: SESSION, tools: [] });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ session: SESSION, tools: [TOOL] }), {
        status: 200,
      }),
    );
    expect(
      await useWebmcpInspectorStore
        .getState()
        .refreshToolsForChat(SESSION.sessionId),
    ).toBe(true);
    expect(useWebmcpInspectorStore.getState().tools).toEqual([TOOL]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toContain("?refreshTools=1");
    expect(fetchSpy.mock.calls[0][1]?.method).toBe("GET");
  });

  it("does not apply a tool refresh to a replacement session", async () => {
    useWebmcpInspectorStore.setState({ session: SESSION, tools: [] });
    let release!: (response: Response) => void;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const refreshing = useWebmcpInspectorStore
      .getState()
      .refreshToolsForChat(SESSION.sessionId);
    await vi.waitFor(() => expect(release).toBeDefined());
    useWebmcpInspectorStore.setState({
      session: { ...SESSION, sessionId: "replacement" },
    });
    release(
      new Response(JSON.stringify({ session: SESSION, tools: [TOOL] }), {
        status: 200,
      }),
    );
    expect(await refreshing).toBe(false);
    expect(useWebmcpInspectorStore.getState().tools).toEqual([]);
  });

  it("recovers a retained result through a read-only request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          invokeId: "recover",
          outcome: { state: "succeeded", output: "paid" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const result = await useWebmcpInspectorStore
      .getState()
      .recoverInvocationResult("original-session", "recover");
    expect(result).toMatchObject({
      state: "succeeded",
      output: "paid",
      invokeId: "recover",
    });
    expect(String(fetchSpy.mock.calls[0][0])).toContain(
      "/sessions/original-session/invocations/recover",
    );
    expect(fetchSpy.mock.calls[0][1]?.method).toBe("GET");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps a pending recovery unknown without issuing an invoke", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ invokeId: "recover", pending: true }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      useWebmcpInspectorStore
        .getState()
        .recoverInvocationResult("original-session", "recover"),
    ).resolves.toMatchObject({ state: "unknown", invokeId: "recover" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][1]?.method).toBe("GET");
  });

  it("reports a session that went away and drops its state", async () => {
    const source = await openSession();
    await source.emit({ type: "session_gone", error: "That session is gone." });

    const state = useWebmcpInspectorStore.getState();
    expect(state.session).toBeUndefined();
    expect(state.error?.code).toBe("session-not-found");
  });

  it("survives a malformed frame and an unknown event type", async () => {
    const source = await openSession();
    source.onmessage?.({ data: "not json at all" });
    await source.emit({ type: "something-new", seq: 4 });
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
    //
    // The id comes off the REQUEST, because the client mints it now: it has to
    // be stable across a retry, and a server-issued one cannot be (the retry
    // would get a different one, and a side-effecting page tool would run
    // twice). The server echoes whatever it was sent.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const invokeId = JSON.parse(String((init as RequestInit).body)).invokeId;
      await source.emit(activityEvent(settled("a2", invokeId), 2));
      return new Response(JSON.stringify({ invokeId }), { status: 202 });
    });

    // Without the early-settle cache this would sit out the 90s timeout and
    // then report a failure for a tool that succeeded.
    await expect(
      useWebmcpInspectorStore.getState().invokeToolForResult(TOOL.toolKey, {}),
    ).resolves.toMatchObject({ state: "succeeded", output: "ok" });
  });

  it("preserves a definite stale refusal delivered on SSE for chat recovery", async () => {
    const source = await openSession();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const invokeId = JSON.parse(String(init?.body)).invokeId;
      await source.emit(
        activityEvent(
          {
            ...settled("stale", invokeId),
            kind: "invocation_settled",
            invokeId,
            toolKey: TOOL.toolKey,
            source: "chat",
            durationMs: 0,
            state: "failed",
            errorCode: "tool-gone",
          },
          2,
        ),
      );
      return new Response(JSON.stringify({ invokeId }), { status: 202 });
    });
    await expect(
      useWebmcpInspectorStore.getState().invokeToolForResult(TOOL.toolKey, {}),
    ).resolves.toMatchObject({ state: "failed", errorCode: "tool-gone" });
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
    await expect(pending).resolves.toMatchObject({
      state: "unknown",
      invokeId: expect.any(String),
    });
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

    await source.emit({ type: "session_gone", error: "That session is gone." });
    await expect(pending).resolves.toMatchObject({
      state: "unknown",
      invokeId: expect.any(String),
    });
  });

  it("does not hand one session's cached result to the next", async () => {
    const source = await openSession();
    await source.emit(activityEvent(settled("a2", "inv-1"), 2));

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
    await source.emit({ type: "tools", seq: 2, tools: [TOOL] });
    await source.emit({ type: "tools", seq: 3, tools: [] });
    expect(useWebmcpInspectorStore.getState().tools).toEqual([]);
  });

  it("clears the timeline without resurrecting dismissed rows or pending", async () => {
    const source = await openSession();
    await source.emit(activityEvent(started("a1", "inv-1")));
    await source.emit(activityEvent(settled("a2", "inv-1"), 2));
    await source.emit(activityEvent(started("a3", "inv-2"), 3));

    useWebmcpInspectorStore.getState().clearActivity();

    const afterClear = useWebmcpInspectorStore.getState();
    expect(afterClear.activity).toEqual([]);
    // Clearing the log is not cancelling a running tool.
    expect(afterClear.pending.map((item) => item.invokeId)).toEqual(["inv-2"]);

    // Stream reconnects replay the ring. Forgetting seen ids would put every
    // dismissed row back the next time the stream hiccups.
    await source.emit(activityEvent(started("a1", "inv-1")));
    await source.emit(activityEvent(settled("a2", "inv-1"), 2));
    expect(useWebmcpInspectorStore.getState().activity).toEqual([]);

    await source.emit(activityEvent(settled("a4", "inv-2"), 4));
    expect(
      useWebmcpInspectorStore.getState().activity.map((entry) => entry.id),
    ).toEqual(["a4"]);
    expect(useWebmcpInspectorStore.getState().pending).toEqual([]);
  });

  it("ignores a frame event on the timeline stream", async () => {
    const source = await openSession();
    // The event stream carried pixels once, in a coalesced slot beside the
    // timeline. It no longer does — they have their own socket — and a server
    // that somehow sent one must not be able to put a filmstrip into the
    // record the session exists to produce.
    await source.emit({
      type: "frame",
      seq: 2,
      frame: { data: "one", deviceWidth: 1280, deviceHeight: 800, ts: 1 },
    });

    expect(useWebmcpInspectorStore.getState().activity).toEqual([]);
    expect(webmcpFrameChannel.latest()).toBeNull();
  });

  it("keeps the live frame separate from the manual screenshot", async () => {
    const { ws } = await openFrameSession();
    ws.open();
    useWebmcpInspectorStore.setState({ lastScreenshot: "manual-capture" });
    await ws.emitFrame(binaryFrame(2));
    // Two places on purpose: one is the live picture on its own channel, the
    // other a snapshot someone asked for in the store. Collapsing them would
    // make the invoke pane's thumbnail flicker with every paint.
    expect(useWebmcpInspectorStore.getState().lastScreenshot).toBe(
      "manual-capture",
    );
    expect(webmcpFrameChannel.latest()?.seq).toBe(2);
  });

  it("ignores an event type it does not know, without losing the stream", async () => {
    const source = await openSession();
    await source.emit({ type: "invented_later", seq: 2, payload: { a: 1 } });
    // The old shape fell through to the activity branch for anything that was
    // not `session` or `tools`, so a newer server's first new event type threw
    // on `event.entry` — swallowed by onmessage's catch, which turns "your
    // client is older than your server" into an unexplained gap.
    await source.emit({ type: "tools", seq: 3, tools: [TOOL] });
    expect(useWebmcpInspectorStore.getState().tools).toHaveLength(1);
    expect(useWebmcpInspectorStore.getState().activity).toEqual([]);
  });

  it("drops the live frame when the session goes away", async () => {
    const source = await openSession();
    await source.emit({
      type: "frame",
      seq: 2,
      frame: { data: "paint", deviceWidth: 1280, deviceHeight: 800, ts: 1 },
    });
    await source.emit({ type: "session_gone", error: "That session is gone." });
    // Nothing is going to correct that picture now, so showing it would be a
    // page the viewer believes is current and is not.
    expect(webmcpFrameChannel.latest()).toBeNull();
  });

  it("reports a refused screencast without putting it in the banner", async () => {
    await openSession();
    paintChannel();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Invalid command." }), {
        status: 400,
      }),
    );

    const accepted = await useWebmcpInspectorStore
      .getState()
      .setScreencast(true);

    expect(accepted).toBe(false);
    expect(webmcpFrameChannel.latest()).toBeNull();
    // NOT surfaced in the error banner: a refusal here is a lifecycle fact for
    // the pane to act on, and "Invalid command." in front of someone whose
    // pane is about to start working anyway is a bug report we would rather
    // not receive.
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

    paintChannel();
    // False after a stop is the honest answer: nothing is flowing now.
    expect(await useWebmcpInspectorStore.getState().setScreencast(false)).toBe(
      false,
    );
    expect(webmcpFrameChannel.latest()).toBeNull();
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

  it("uses server DPR 1 even when the viewer uses a Retina display", async () => {
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
      expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toEqual({
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

  it("does not publish a store change to clear an already empty error", async () => {
    await openSession();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const changed = vi.fn();
    const unsubscribe = useWebmcpInspectorStore.subscribe(changed);
    await useWebmcpInspectorStore
      .getState()
      .sendInput([{ kind: "mouse_move", x: 1, y: 1 }]);
    expect(changed).not.toHaveBeenCalled();
    unsubscribe();
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

  it("treats a 200 with streaming:false as nothing flowing yet", async () => {
    await openSession();
    paintChannel();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, streaming: false }), {
        status: 200,
      }),
    );

    // The server understood the command and no frames are flowing — the daemon
    // has no tab selected yet. Reading only the status would leave the pane
    // claiming a live picture it is not receiving.
    expect(await useWebmcpInspectorStore.getState().setScreencast(true)).toBe(
      false,
    );
    expect(webmcpFrameChannel.latest()).toBeNull();
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

  it("clears the error banner, because a person pressed the button", async () => {
    await openSession();
    useWebmcpInspectorStore.setState({
      error: { message: "That page could not be reached." },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ screenshotBase64: "shot" }), {
        status: 200,
      }),
    );

    // Every capture is a person acting on the banner now. The `silent` mode
    // that kept the once-a-second poll out of it went with the poll: nothing
    // else calls this, so nothing can wipe a navigation or invocation failure
    // before anyone has read it.
    await useWebmcpInspectorStore.getState().captureScreenshot();
    expect(useWebmcpInspectorStore.getState().lastScreenshot).toBe("shot");
    expect(useWebmcpInspectorStore.getState().error).toBeUndefined();
  });

  it("does not land a capture in the session that replaced it", async () => {
    await openSession();
    const { fetchSpy, release } = deferredFetch();

    const capturing = useWebmcpInspectorStore.getState().captureScreenshot();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    // A capture's request outlives a close, so the session turning over
    // underneath one is routine: press Screenshot, then close the page.
    useWebmcpInspectorStore.setState({
      session: { ...SESSION, sessionId: "session-2" },
    });
    release(
      new Response(JSON.stringify({ screenshotBase64: "old-site" }), {
        status: 200,
      }),
    );
    await capturing;

    // The pane falls back to `lastScreenshot` before its first frame, so this
    // would hang the PREVIOUS page's paint in the new session's live view —
    // where nothing would correct it, because it is not stale, it is simply
    // the wrong page.
    expect(useWebmcpInspectorStore.getState().lastScreenshot).toBeUndefined();
  });

  it("does not clear the next session's frame when a stale toggle is refused", async () => {
    await openSession();
    const { fetchSpy, release } = deferredFetch();

    const toggling = useWebmcpInspectorStore.getState().setScreencast(true);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    useWebmcpInspectorStore.setState({
      session: { ...SESSION, sessionId: "session-2" },
    });
    paintChannel(77);
    release(
      new Response(JSON.stringify({ error: "Invalid command." }), {
        status: 400,
      }),
    );
    expect(await toggling).toBe(false);

    // The refusal belongs to the session that asked. Acting on it here would
    // blank a pane that is streaming perfectly well, and nothing would repaint
    // it until the page next changed on its own.
    expect(webmcpFrameChannel.latest()?.seq).toBe(77);
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

    // Two captures in flight at once — a second press while the first is
    // still out, which a slow page makes easy to do.
    const first = useWebmcpInspectorStore.getState().captureScreenshot();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const second = useWebmcpInspectorStore.getState().captureScreenshot();
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
    // Applying it would step the pane backwards a picture, onto the page as
    // it was before the one the person is already looking at.
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

    const first = useWebmcpInspectorStore.getState().captureScreenshot();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const second = useWebmcpInspectorStore.getState().captureScreenshot();
    await vi.waitFor(() => expect(releases).toHaveLength(2));

    // The newer capture FAILS — a blip on the second press.
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

  it("keeps the picture when a capture answers without one", async () => {
    await openSession();
    const releases: Array<(response: Response) => void> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          releases.push(resolve);
        }),
    );

    const first = useWebmcpInspectorStore.getState().captureScreenshot();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const second = useWebmcpInspectorStore.getState().captureScreenshot();
    await vi.waitFor(() => expect(releases).toHaveLength(2));

    // 200, and no picture: the provider holds outstanding captures at one, so
    // the second press answers this way while the first is still out. It is
    // "nothing to show you right now", NOT "the page is blank".
    releases[1](new Response("{}", { status: 200 }));
    await second;

    // The real capture, still on its way when that landed. Had the empty
    // answer claimed the slot, this would be rejected as stale and the pane
    // would stay blank until somebody pressed again.
    releases[0](
      new Response(JSON.stringify({ screenshotBase64: "real" }), {
        status: 200,
      }),
    );
    await first;
    expect(useWebmcpInspectorStore.getState().lastScreenshot).toBe("real");
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
  beforeEach(() => {
    useWebmcpInspectorStore.getState().disconnect();
    FakeEventSource.instances = [];
    FakeWebSocket.instances = [];
    (
      window as unknown as { __MCP_SESSION_TOKEN__?: string }
    ).__MCP_SESSION_TOKEN__ = "test-token";
    vi.restoreAllMocks();
    useWebmcpInspectorStore.setState({
      session: undefined,
      tools: [],
      activity: [],
      pending: [],
      starting: false,
      error: undefined,
      frameTransport: { rung: "none", attempts: 0, latched: false },
      lastScreenshot: undefined,
      chatEnabled: false,
    });
    webmcpFrameChannel.publish(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses negotiated socket input, records its ack, and does not dirty the workspace", async () => {
    const { ws } = await openFrameSession();
    ws.open();
    ws.onmessage?.({
      data: JSON.stringify({ type: "capabilities", features: ["input"] }),
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockClear();
    const changed = vi.fn();
    const unsubscribe = useWebmcpInspectorStore.subscribe(changed);
    const pending = useWebmcpInspectorStore
      .getState()
      .sendInput([{ kind: "wheel", x: 1, y: 1, deltaX: 0, deltaY: 20 }]);
    await Promise.resolve();
    const message = JSON.parse(ws.sent.at(-1)!);
    expect(message.type).toBe("input");
    ws.onmessage?.({
      data: JSON.stringify({
        type: "input_ack",
        seq: message.seq,
        dispatched: 1,
      }),
    });
    await pending;
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("sends the next ordered socket batch before the previous ack", async () => {
    const { ws } = await openFrameSession();
    ws.open();
    ws.onmessage?.({
      data: JSON.stringify({ type: "capabilities", features: ["input"] }),
    });
    const first = useWebmcpInspectorStore
      .getState()
      .sendInput([{ kind: "text", text: "first" }]);
    const second = useWebmcpInspectorStore
      .getState()
      .sendInput([{ kind: "text", text: "second" }]);
    await vi.waitFor(() =>
      expect(
        ws.sent.filter((s) => JSON.parse(s).type === "input"),
      ).toHaveLength(2),
    );
    const messages = ws.sent
      .map((s) => JSON.parse(s))
      .filter((s) => s.type === "input");
    expect(messages.map((m) => m.events[0].text)).toEqual(["first", "second"]);
    for (const message of messages)
      ws.onmessage?.({
        data: JSON.stringify({
          type: "input_ack",
          seq: message.seq,
          dispatched: 1,
        }),
      });
    await Promise.all([first, second]);
  });

  it("keeps binary frames after an ack timeout and sends only later input over HTTP", async () => {
    const { ws, sse } = await openFrameSession();
    vi.useFakeTimers();
    ws.open();
    ws.onmessage?.({
      data: JSON.stringify({ type: "capabilities", features: ["input"] }),
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockClear();
    const pending = useWebmcpInspectorStore
      .getState()
      .sendInput([{ kind: "text", text: "uncertain" }]);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5001);
    await pending;
    expect(fetchSpy).not.toHaveBeenCalled();
    // The FRAME stream is untouched by an input timeout: pixels and gestures
    // fail independently, and demoting the picture because a gesture went
    // unanswered would turn one silent batch into a dead pane.
    expect(sse.url).not.toContain("frames");
    expect(useWebmcpInspectorStore.getState().frameTransport.rung).toBe("ws");
    const count = ws.sent.length;
    await useWebmcpInspectorStore
      .getState()
      .sendInput([{ kind: "text", text: "later" }]);
    expect(ws.sent).toHaveLength(count);
    expect(fetchSpy).toHaveBeenCalled();
    expect(
      fetchSpy.mock.calls.some(([, init]) =>
        String(init?.body).includes("uncertain"),
      ),
    ).toBe(false);
  });

  it("surfaces interrupted socket input without replaying it over HTTP", async () => {
    const { ws } = await openFrameSession();
    ws.open();
    ws.onmessage?.({
      data: JSON.stringify({ type: "capabilities", features: ["input"] }),
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockClear();
    const pending = useWebmcpInspectorStore
      .getState()
      .sendInput([{ kind: "text", text: "only once" }]);
    await Promise.resolve();
    ws.emitClose(4401);
    await pending;
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(useWebmcpInspectorStore.getState().error?.message).toContain(
      "not replayed",
    );
  });

  it("opens the socket, and never asks the event stream for pixels", async () => {
    const { sse, ws } = await openFrameSession();

    // The event stream carries the session, its tools and its timeline. It has
    // never been asked for frames since the socket became the only picture.
    expect(sse.url).not.toContain("frames");
    expect(ws.url).toBe(
      "ws://localhost:3000/api/web/webmcp/sessions/session-1/frames",
    );
    // The nonce rides the subprotocol so it never lands in an access log —
    // and it is the nonce the route just minted, never the ambient session
    // token, which would be a long-lived credential on a viewer's socket.
    expect(ws.protocols).toEqual(["test-nonce"]);
    expect(ws.binaryType).toBe("arraybuffer");
  });

  it("opens no socket, and no frames param, for any other session", async () => {
    // A native-window session drives a real browser the person is looking at,
    // and a hosted one paints in a datacenter. Neither has pixels to carry.
    const sse = await openSession();
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(sse.url).not.toContain("frames=");
  });

  it("decodes a frame through the shared reader and publishes it, not a store update", async () => {
    const { ws } = await openFrameSession();
    ws.open();
    const changed = vi.fn();
    const unsubscribe = useWebmcpInspectorStore.subscribe(changed);
    await ws.emitFrame(
      binaryFrame(7, { deviceWidth: 1024, deviceHeight: 640 }),
    );

    expect(webmcpFrameChannel.latest()).toMatchObject({
      deviceWidth: 1024,
      deviceHeight: 640,
      scale: 1,
      ts: 5_000,
      seq: 7,
    });
    // Already decoded, off the main thread, by the same reader the Playground
    // panes use — there is no second decode waiting in the component.
    expect(webmcpFrameChannel.latest()?.bitmap).toBeDefined();
    // AND NOT A STORE UPDATE. The whole point of the channel: thirty frames a
    // second must not re-render a workspace of panels that do not draw them.
    expect(changed).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("closes the bitmap a newer frame replaces, and the last one on teardown", async () => {
    const { ws } = await openFrameSession();
    ws.open();
    await ws.emitFrame(binaryFrame(1));
    await ws.emitFrame(binaryFrame(2));

    // An ImageBitmap holds a decoded surface the garbage collector cannot see
    // the cost of; a stream at 30fps that kept them all would hold a second of
    // decoded video at all times.
    expect(bitmaps.map((b) => b.closed)).toEqual([true, false]);

    useWebmcpInspectorStore.getState().disconnect();
    expect(bitmaps.every((b) => b.closed)).toBe(true);
  });

  it("carries the capture scale, so the pane can put clicks in the page's units", async () => {
    const { ws } = await openFrameSession();
    ws.open();
    await ws.emitFrame(
      binaryFrame(7, { deviceWidth: 2560, deviceHeight: 1600, scale: 2 }),
    );

    // The picture is 2560 pixels wide and the page is 1280 CSS pixels wide.
    // Scaling a click against the former sends it to twice the coordinate the
    // person pointed at, so the ratio has to survive the wire — the pane does
    // the division.
    expect(webmcpFrameChannel.latest()).toMatchObject({
      deviceWidth: 2560,
      deviceHeight: 1600,
      scale: 2,
    });
  });

  it("reads a missing or nonsense scale as 1", async () => {
    const { ws } = await openFrameSession();
    ws.open();
    // No scale at all: every writer older than the field, and every provider
    // that does not capture above CSS resolution.
    await ws.emitFrame(binaryFrame(7));
    expect(webmcpFrameChannel.latest()?.scale).toBe(1);

    // Zero would divide the geometry into infinity and put the pane's box
    // somewhere no click could reach.
    await ws.emitFrame(binaryFrame(8, { scale: 0 }));
    expect(webmcpFrameChannel.latest()?.scale).toBe(1);
  });

  it("drops an out-of-order frame on the socket", async () => {
    const { ws } = await openFrameSession();
    ws.open();
    await ws.emitFrame(binaryFrame(10));
    // A replayed frame on a reconnected socket can be older than what the
    // previous socket already delivered, and painting it would move the pane
    // backwards — taking the click mapping with it.
    await ws.emitFrame(binaryFrame(9, { ts: 1 }));
    expect(webmcpFrameChannel.latest()?.seq).toBe(10);
    await ws.emitFrame(binaryFrame(10, { ts: 2 }));
    expect(webmcpFrameChannel.latest()?.ts).toBe(5_000);

    await ws.emitFrame(binaryFrame(11, { ts: 3 }));
    expect(webmcpFrameChannel.latest()?.seq).toBe(11);
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
    // Nothing is carrying pixels — this socket never opened — but the ladder
    // is still retrying, and `latched: false` is what says so. That is the
    // distinction the pane's notice reads: not "is there a stream right now",
    // but "is one still coming".
    expect(transport()).toMatchObject({ rung: "none", latched: false });

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
    // nothing is carrying pixels and nothing will for the rest of the session,
    // which is what the pane's notice says.
    expect(transport()).toEqual({
      rung: "none",
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
      rung: "none",
      attempts: 1,
      latched: true,
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("retries three times, then latches", async () => {
    vi.useFakeTimers();
    const { ws } = await openFrameSession();

    ws.emitClose(1006);
    expect(FakeWebSocket.instances).toHaveLength(1);

    for (const [attempt, delay] of [
      [2, 500],
      [3, 1_000],
      [4, 2_000],
    ] as const) {
      vi.advanceTimersByTime(delay - 1);
      await socketOpened();
      expect(FakeWebSocket.instances).toHaveLength(attempt - 1);
      vi.advanceTimersByTime(1);
      await socketOpened();
      expect(FakeWebSocket.instances).toHaveLength(attempt);
      FakeWebSocket.instances.at(-1)!.emitClose(1006);
    }

    // FOUR attempts total, then never again for this session: a socket
    // churning forever in the background helps nobody, and the pane says
    // plainly that live view is unavailable rather than pretending.
    vi.advanceTimersByTime(60_000);
    await socketOpened();
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
      await socketOpened();
      current = FakeWebSocket.instances.at(-1)!;
      current.open();
    }
    expect(FakeWebSocket.instances).toHaveLength(4);

    // Without the reset, the fourth close would exhaust a budget meant for the
    // structural case and latch a session that has been working all along.
    current.emitClose(1006);
    vi.advanceTimersByTime(500);
    await socketOpened();
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
      await socketOpened();
      FakeWebSocket.instances.at(-1)!.emitClose(1006);
    }
    vi.advanceTimersByTime(60_000);
    await socketOpened();
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it("does not retry on 4404 or 1000", async () => {
    vi.useFakeTimers();
    for (const code of [4404, 1000]) {
      FakeWebSocket.instances = [];
      FakeEventSource.instances = [];
      const { ws } = await openFrameSession(`session-${code}`);
      ws.emitClose(code);

      // The session is over, or we asked for this. The SSE stream carries the
      // story either way, and there is nothing left to stream.
      vi.advanceTimersByTime(60_000);
      expect(FakeWebSocket.instances, String(code)).toHaveLength(1);
    }
  });

  it("latches without retrying on 4401 and 4503", async () => {
    vi.useFakeTimers();
    for (const code of [4401, 4503]) {
      FakeWebSocket.instances = [];
      FakeEventSource.instances = [];
      const { ws } = await openFrameSession(`session-${code}`);
      ws.emitClose(code);

      // Auth, or the feature being off, is not something a retry fixes.
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
    await current.emitFrame(binaryFrame(4));
    const painted = webmcpFrameChannel.latest();

    // A message already dispatched when the session turned over, and a close
    // event racing our own close(). Both belong to a generation that is gone.
    await stale.emitFrame(binaryFrame(99));
    stale.emitClose(1006);

    expect(webmcpFrameChannel.latest()).toBe(painted);
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances.at(-1)).toBe(current);
  });

  it("ignores a text message, and holds a partial record rather than throwing", async () => {
    const { ws } = await openFrameSession();
    ws.open();
    await ws.emitFrame(binaryFrame(3));
    const painted = webmcpFrameChannel.latest();

    // A pong is control traffic, not a paint.
    expect(() =>
      ws.onmessage?.({ data: JSON.stringify({ type: "pong" }) }),
    ).not.toThrow();
    // A record split across messages is the NORMAL case on this wire — a
    // 256 KiB JPEG does not fit in one WebSocket frame — so the reader buffers
    // the head and waits rather than throwing inside a `message` handler.
    const encoded = encodeFrameStreamRecord({
      kind: FRAME_STREAM_KIND.frame,
      scale: 1,
      ...binaryFrame(4),
    });
    expect(() =>
      ws.onmessage?.({ data: encoded.buffer.slice(0, 12) }),
    ).not.toThrow();
    await decoded();

    expect(webmcpFrameChannel.latest()).toBe(painted);
  });

  it("drops the connection on a record it cannot make sense of", async () => {
    const { ws } = await openFrameSession();
    ws.open();
    // A reader that has lost its place in a byte stream can never find it
    // again — there is no framing marker to resynchronise against — so the
    // honest answer is to drop the socket and let the ladder decide.
    const corrupt = encodeFrameStreamRecord({
      kind: FRAME_STREAM_KIND.frame,
      scale: 1,
      ...binaryFrame(4),
    });
    corrupt[1] = 9; // a kind no reader knows
    ws.onmessage?.({
      data: corrupt.buffer.slice(
        corrupt.byteOffset,
        corrupt.byteOffset + corrupt.byteLength,
      ),
    });
    expect(ws.closedByClient).toBe(true);
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

  it("clears the frame and releases its bitmap when the stream stops", async () => {
    const { ws } = await openFrameSession();
    ws.open();
    await ws.emitFrame(binaryFrame(2));

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, streaming: false }), {
        status: 200,
      }),
    );
    await useWebmcpInspectorStore.getState().setScreencast(false);

    // Reset #2: the picture is no longer current, so it goes — and the surface
    // behind it goes with it, in that order, so nothing is drawing from a
    // bitmap that has been released.
    expect(webmcpFrameChannel.latest()).toBeNull();
    expect(bitmaps.every((b) => b.closed)).toBe(true);
    // The socket is NOT closed: a screencast toggle follows tab visibility,
    // and a handshake per flip is pure cost.
    expect(ws.closedByClient).toBe(false);
  });

  it("does not resurrect a frame still decoding when live view stops", async () => {
    const { ws } = await openFrameSession();
    ws.open();
    // The decode is HELD open across the toggle. Resolving it immediately
    // would publish the frame BEFORE the toggle and prove only that the
    // channel was cleared — the race a person makes by closing the pane
    // mid-scroll is a decode that lands AFTER.
    let release!: () => void;
    vi.stubGlobal("createImageBitmap", () => {
      const bitmap: FakeBitmap = {
        closed: false,
        close() {
          this.closed = true;
        },
      };
      bitmaps.push(bitmap);
      return new Promise<FakeBitmap>((resolve) => {
        release = () => resolve(bitmap);
      });
    });
    await ws.emitFrame(binaryFrame(2), false);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ streaming: false }), { status: 200 }),
    );
    await useWebmcpInspectorStore.getState().setScreencast(false);
    expect(webmcpFrameChannel.latest()).toBeNull();

    release();
    await decoded();
    expect(webmcpFrameChannel.latest()).toBeNull();
    // And it is not merely withheld: nobody else will ever free this surface.
    expect(bitmaps.at(-1)!.closed).toBe(true);
    expect(ws.closedByClient).toBe(false);
  });

  it("resets the seq guard on teardown, so the next session paints", async () => {
    const { ws } = await openFrameSession("session-old");
    ws.open();
    await ws.emitFrame(binaryFrame(500));

    const { ws: next } = await openFrameSession("session-new");
    next.open();
    // A new session's counter starts at 1. A guard that survived teardown
    // would swallow every frame of it, and the pane would never paint again.
    await next.emitFrame(binaryFrame(1));
    expect(webmcpFrameChannel.latest()?.seq).toBe(1);
  });

  it("drops pending latency samples when the session is torn down", async () => {
    localStorage.setItem("webmcp:frame-stats", "1");
    resetFrameStatsFlagForTests();
    try {
      const { ws } = await openFrameSession("session-old");
      ws.open();
      await ws.emitFrame(binaryFrame(2));
      // The gesture, as `sendInput` records it. Called directly rather than
      // through the pane, because the settling half (`notePainted`) is the
      // <img>'s `onLoad` and no pane is rendered here — what this test owns is
      // whether the store's TEARDOWN drops what is pending.
      noteInputSent(2);

      const { ws: next } = await openFrameSession("session-new");
      next.open();
      await next.emitFrame(binaryFrame(9));

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
    await ws.emitFrame(binaryFrame(2));

    await sse.emit({ type: "session_gone", error: "That session is gone." });
    expect(ws.closedByClient).toBe(true);
    expect(webmcpFrameChannel.latest()).toBeNull();
  });

  it("tears the socket down on disconnect and rebuilds it on reconnect", async () => {
    const { ws } = await openFrameSession();
    ws.open();

    useWebmcpInspectorStore.getState().disconnect();
    expect(ws.closedByClient).toBe(true);

    useWebmcpInspectorStore.getState().reconnect();
    await socketOpened();
    const resumed = FakeWebSocket.instances.at(-1)!;
    expect(resumed).not.toBe(ws);
    resumed.open();
    await resumed.emitFrame(binaryFrame(1));
    expect(webmcpFrameChannel.latest()?.seq).toBe(1);
  });
});

it("allows the server queue budget, then returns unknown with the original id on a lost settle", async () => {
  vi.useFakeTimers();
  const before = useWebmcpInspectorStore.getState();
  let acceptedId: string | undefined;
  useWebmcpInspectorStore.setState({
    sendCommand: async (command) => {
      if (command.type !== "invoke_tool") throw new Error("unexpected command");
      acceptedId = command.invokeId;
      return { invokeId: acceptedId };
    },
  });
  try {
    const settled = vi.fn();
    const result = useWebmcpInspectorStore
      .getState()
      .invokeToolForResult("origin::pay", {});
    void result.then(settled);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500_000);
    await expect(result).resolves.toMatchObject({
      state: "unknown",
      invokeId: acceptedId,
      errorMessage: expect.stringContaining("before retrying"),
    });
  } finally {
    useWebmcpInspectorStore.setState(before);
    vi.useRealTimers();
  }
});

// Authenticated fetch streams replace EventSource. Keep the existing transport
// fixture's emit/close controls, with actual SSE bytes flowing through the reader.
vi.mock("@/lib/session-token", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/session-token")>();
  return {
    ...original,
    authFetch: async (input: string, init?: RequestInit) => {
      if (input.includes("/events")) {
        const stream = new FakeEventSource(input);
        init?.signal?.addEventListener("abort", () => stream.close());
        return new Response(
          new ReadableStream({
            start(controller) {
              stream.controller = controller;
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      if (input.endsWith("/stream-nonce"))
        return new Response(JSON.stringify({ nonce: "test-nonce" }));
      return fetch(input, init);
    },
  };
});
