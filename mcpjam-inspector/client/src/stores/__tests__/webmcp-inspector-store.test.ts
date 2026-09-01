/**
 * The store holds the surface's easiest-to-get-wrong logic: SSE frame parsing,
 * activity bookkeeping across reconnects, and pending-invocation state that
 * decides whether Invoke is disabled.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useWebmcpInspectorStore } from "../webmcp-inspector-store";
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
async function openSession() {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(SESSION), { status: 201 }),
  );
  await useWebmcpInspectorStore.getState().startSession("https://shop.test/");
  return FakeEventSource.instances.at(-1)!;
}

describe("webmcp inspector store", () => {
  beforeEach(() => {
    // The stream handle is module-scoped and `connect` is idempotent per
    // session id, so without this the next test reuses the previous stream and
    // never gets a FakeEventSource of its own.
    useWebmcpInspectorStore.getState().disconnect();
    FakeEventSource.instances = [];
    vi.restoreAllMocks();
    useWebmcpInspectorStore.setState({
      session: undefined,
      tools: [],
      activity: [],
      pending: [],
      starting: false,
      error: undefined,
      liveFrame: undefined,
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
    expect(state.liveFrame).toMatchObject({ data: "two", deviceWidth: 640 });
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
    expect(state.liveFrame?.data).toBe("paint");
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
      liveFrame: { data: "paint", deviceWidth: 1280, deviceHeight: 800, ts: 1 },
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
      liveFrame: { data: "paint", deviceWidth: 1280, deviceHeight: 800, ts: 1 },
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
      liveFrame: { data: "paint", deviceWidth: 1280, deviceHeight: 800, ts: 1 },
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
      liveFrame: { data: "fresh", deviceWidth: 1280, deviceHeight: 800, ts: 2 },
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
    expect(useWebmcpInspectorStore.getState().liveFrame?.data).toBe("fresh");
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
