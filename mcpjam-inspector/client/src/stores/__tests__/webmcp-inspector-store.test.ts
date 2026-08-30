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
});
