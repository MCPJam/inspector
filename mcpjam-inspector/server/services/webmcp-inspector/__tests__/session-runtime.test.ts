import { describe, it, expect, vi } from "vitest";
import {
  WEBMCP_RESULT_CAP_BYTES,
  capResult,
  type WebMcpActivityEntry,
  type WebMcpEvent,
} from "@/shared/webmcp-inspector-protocol";
import {
  assignToolKeys,
  WebMcpQueueFullError,
  WebMcpSessionRuntime,
} from "../session-runtime";
import { WebMcpToolGoneError } from "../provider";
import { FakeBrowserSession, fakeTool } from "./fake-provider";

function makeRuntime(
  options: { invokeTimeoutMs?: number; queueLimit?: number } = {},
) {
  const onActivity = vi.fn();
  const runtime = new WebMcpSessionRuntime("https://example.test/", {
    sessionId: "session-1",
    invokeTimeoutMs: options.invokeTimeoutMs ?? 60_000,
    queueLimit: options.queueLimit,
    onActivity,
  });
  const session = new FakeBrowserSession(
    runtime.callbacks(),
    "https://example.test/",
  );
  const events: WebMcpEvent[] = [];
  runtime.hub.subscribe((event) => events.push(event), 0);
  runtime.attach(session);
  const activity = () =>
    events
      .filter(
        (e): e is Extract<WebMcpEvent, { type: "activity" }> =>
          e.type === "activity",
      )
      .map((e) => e.entry);
  return { runtime, session, events, activity, onActivity };
}

function entryOfKind<K extends WebMcpActivityEntry["kind"]>(
  entries: WebMcpActivityEntry[],
  kind: K,
): Extract<WebMcpActivityEntry, { kind: K }> | undefined {
  return entries.find((e) => e.kind === kind) as
    Extract<WebMcpActivityEntry, { kind: K }> | undefined;
}

describe("tool identity", () => {
  it("keys a tool by origin and name, not by frame id", () => {
    const [tool] = assignToolKeys([
      fakeTool({ frameId: "frame-abc", origin: "https://shop.test" }),
    ]);
    expect(tool.toolKey).toBe("https://shop.test::echo");
    // Frame ids churn across navigations, so identity must not embed one.
    expect(tool.toolKey).not.toContain("frame-abc");
  });

  it("disambiguates same-name tools from different frames of one origin", () => {
    const tools = assignToolKeys([
      fakeTool({ frameId: "frame-1", origin: "https://shop.test" }),
      fakeTool({
        frameId: "frame-2",
        origin: "https://shop.test",
        isMainFrame: false,
      }),
    ]);
    expect(new Set(tools.map((t) => t.toolKey)).size).toBe(2);
    for (const tool of tools) {
      expect(tool.toolKey).toMatch(/^https:\/\/shop\.test::echo#[0-9a-f]{4}$/);
    }
  });

  it("keeps same-name tools from different origins apart without a suffix", () => {
    const tools = assignToolKeys([
      fakeTool({ frameId: "frame-1", origin: "https://a.test" }),
      fakeTool({
        frameId: "frame-2",
        origin: "https://b.test",
        isMainFrame: false,
      }),
    ]);
    expect(tools.map((t) => t.toolKey)).toEqual([
      "https://a.test::echo",
      "https://b.test::echo",
    ]);
  });

  it("marks subframe provenance and registration kind", () => {
    const tools = assignToolKeys([
      fakeTool({ isMainFrame: true, registrationKind: "imperative" }),
      fakeTool({
        frameId: "frame-2",
        name: "declared",
        isMainFrame: false,
        registrationKind: "declarative",
      }),
    ]);
    expect(tools[0]).toMatchObject({
      fromSubframe: false,
      registrationKind: "imperative",
    });
    expect(tools[1]).toMatchObject({
      fromSubframe: true,
      registrationKind: "declarative",
    });
  });
});

describe("tool registry events", () => {
  it("publishes a full snapshot plus added/removed activity", () => {
    const { runtime, session, events, activity } = makeRuntime();
    session.emitTools([fakeTool(), fakeTool({ name: "other" })]);

    const snapshot = events.filter((e) => e.type === "tools").at(-1);
    expect(snapshot?.type).toBe("tools");
    expect(
      snapshot?.type === "tools" ? snapshot.tools.map((t) => t.name) : [],
    ).toEqual(["echo", "other"]);
    expect(entryOfKind(activity(), "tools_added")?.tools).toHaveLength(2);

    // A page navigating away leaves one tool: the other must be reported gone.
    session.emitTools([fakeTool({ name: "other" })]);
    const removed = entryOfKind(activity(), "tools_removed");
    expect(removed?.tools.map((t) => t.name)).toEqual(["echo"]);
    expect(runtime.currentTools().map((t) => t.name)).toEqual(["other"]);
  });

  it("bounds page-authored tool snapshots before publishing them", () => {
    const { runtime, session } = makeRuntime();
    session.emitTools(
      Array.from({ length: 80 }, (_, index) =>
        fakeTool({
          name: `tool-${index}`,
          description: "d".repeat(2_000),
          inputSchema: { blob: "x".repeat(10_000) },
        }),
      ),
    );

    const tools = runtime.currentTools();
    expect(tools).toHaveLength(64);
    expect(tools[0]?.description).toHaveLength(512);
    expect(tools[0]?.inputSchema).toBeUndefined();
  });
});

describe("invocation", () => {
  it("runs a tool and records started/settled with screenshots", async () => {
    const { runtime, session, activity } = makeRuntime();
    session.emitTools([fakeTool()]);

    const { invokeId, settled } = runtime.invoke(
      "https://example.test::echo",
      { text: "hi" },
      "manual",
    );
    const result = await settled;
    expect(result.output).toEqual({ echoed: { text: "hi" } });

    await vi.waitFor(() => {
      expect(entryOfKind(activity(), "invocation_settled")).toBeDefined();
    });
    const started = entryOfKind(activity(), "invocation_started");
    const done = entryOfKind(activity(), "invocation_settled");
    expect(started).toMatchObject({
      invokeId,
      source: "manual",
      input: { text: "hi" },
    });
    expect(started?.screenshotBase64).toBeTruthy();
    expect(done).toMatchObject({ invokeId, state: "succeeded" });
    expect(done?.screenshotBase64).toBeTruthy();
  });

  it("fails cleanly when the tool vanished before it was dequeued", async () => {
    const { runtime, session } = makeRuntime();
    session.emitTools([fakeTool()]);
    // The page navigates: the tool is gone by the time the queue reaches it.
    session.emitTools([]);

    const { settled } = runtime.invoke(
      "https://example.test::echo",
      {},
      "manual",
    );
    await expect(settled).rejects.toBeInstanceOf(WebMcpToolGoneError);
  });

  it("serializes invocations rather than running them concurrently", async () => {
    const { runtime, session } = makeRuntime();
    session.emitTools([fakeTool()]);
    session.hangOnInvoke = true;

    const first = runtime.invoke(
      "https://example.test::echo",
      { n: 1 },
      "manual",
    );
    const second = runtime.invoke(
      "https://example.test::echo",
      { n: 2 },
      "chat",
    );
    first.settled.catch(() => {});
    second.settled.catch(() => {});

    await vi.waitFor(() => expect(session.invocations).toHaveLength(1));
    // The page is one shared surface; a second tool must not start mid-first.
    expect(session.invocations[0].input).toEqual({ n: 1 });
    expect(runtime.inFlight).toBe(2);

    session.pending?.resolve({ output: "one" });
    await first.settled;
    await vi.waitFor(() => expect(session.invocations).toHaveLength(2));
    session.pending?.resolve({ output: "two" });
    await second.settled;
  });

  it("still publishes the settle when the session closes mid-invocation", async () => {
    const { runtime, session, activity } = makeRuntime();
    session.emitTools([fakeTool()]);
    session.hangOnInvoke = true;

    const { settled } = runtime.invoke(
      "https://example.test::echo",
      {},
      "manual",
    );
    settled.catch(() => {});
    await vi.waitFor(() => expect(session.invocations).toHaveLength(1));

    // The hub drops anything published after it closes, so a close that does
    // not wait for the running invocation loses its terminal entry — and the
    // last call of a session reads as though it never finished.
    await runtime.close();

    expect(
      activity().filter((entry) => entry.kind === "invocation_settled"),
    ).toHaveLength(1);
  });

  it("publishes each settle before the next invocation starts", async () => {
    const { runtime, session, activity } = makeRuntime();
    session.emitTools([fakeTool()]);

    const first = runtime.invoke(
      "https://example.test::echo",
      { n: 1 },
      "manual",
    );
    const second = runtime.invoke(
      "https://example.test::echo",
      { n: 2 },
      "manual",
    );
    await first.settled;
    await second.settled;

    await vi.waitFor(() =>
      expect(
        activity().filter((entry) => entry.kind === "invocation_settled"),
      ).toHaveLength(2),
    );
    // The after-screenshot takes long enough that a fire-and-forget publish
    // would let the SECOND invocation's "started" overtake the FIRST's
    // "settled", and the timeline would report the two calls out of order.
    const kinds = activity()
      .filter(
        (entry) =>
          entry.kind === "invocation_started" ||
          entry.kind === "invocation_settled",
      )
      .map((entry) => entry.kind);
    expect(kinds).toEqual([
      "invocation_started",
      "invocation_settled",
      "invocation_started",
      "invocation_settled",
    ]);
  });

  it("frees the session as soon as an invocation settles", async () => {
    const { runtime, session } = makeRuntime();
    session.emitTools([fakeTool()]);
    const { settled } = runtime.invoke(
      "https://example.test::echo",
      {},
      "manual",
    );
    await settled;
    // A caller that awaited the result must be able to navigate immediately;
    // reporting the page as busy here would 409 a legitimate next step.
    expect(runtime.inFlight).toBe(0);
  });

  it("cancels a running invocation and records it as cancelled", async () => {
    const { runtime, session, activity } = makeRuntime();
    session.emitTools([fakeTool()]);
    session.hangOnInvoke = true;

    const { invokeId, settled } = runtime.invoke(
      "https://example.test::echo",
      {},
      "manual",
    );
    await vi.waitFor(() => expect(session.invocations).toHaveLength(1));
    expect(runtime.cancel(invokeId)).toBe(true);
    await expect(settled).rejects.toThrow(/cancel/i);

    await vi.waitFor(() =>
      expect(entryOfKind(activity(), "invocation_settled")?.state).toBe(
        "cancelled",
      ),
    );
  });

  it("drops a queued invocation on cancel without touching the running one", async () => {
    const { runtime, session } = makeRuntime();
    session.emitTools([fakeTool()]);
    session.hangOnInvoke = true;

    const running = runtime.invoke("https://example.test::echo", {}, "manual");
    const queued = runtime.invoke("https://example.test::echo", {}, "manual");
    running.settled.catch(() => {});
    await vi.waitFor(() => expect(session.invocations).toHaveLength(1));

    expect(runtime.cancel(queued.invokeId)).toBe(true);
    await expect(queued.settled).rejects.toThrow(/cancel/i);
    expect(session.invocations).toHaveLength(1);

    session.pending?.resolve({ output: "ok" });
    await running.settled;
  });

  it("reports cancelling an unknown invocation without throwing", () => {
    const { runtime } = makeRuntime();
    // Cancelling something already settled is a race, not a caller error.
    expect(runtime.cancel("never-existed")).toBe(false);
  });

  it("times out a tool that never responds", async () => {
    const { runtime, session, activity } = makeRuntime({ invokeTimeoutMs: 20 });
    session.emitTools([fakeTool()]);
    session.hangOnInvoke = true;

    const { settled } = runtime.invoke(
      "https://example.test::echo",
      {},
      "manual",
    );
    await expect(settled).rejects.toThrow(/timed out/i);
    await vi.waitFor(() =>
      expect(entryOfKind(activity(), "invocation_settled")?.state).toBe(
        "timeout",
      ),
    );
  });

  it("refuses to queue past the limit", () => {
    const { runtime, session } = makeRuntime({ queueLimit: 1 });
    session.emitTools([fakeTool()]);
    session.hangOnInvoke = true;

    runtime
      .invoke("https://example.test::echo", {}, "manual")
      .settled.catch(() => {});
    runtime
      .invoke("https://example.test::echo", {}, "manual")
      .settled.catch(() => {});
    expect(() =>
      runtime.invoke("https://example.test::echo", {}, "manual"),
    ).toThrow(WebMcpQueueFullError);
  });
});

describe("result capping", () => {
  it("leaves a small result untouched", () => {
    const capped = capResult({ content: "small" });
    expect(capped).toMatchObject({ truncated: false });
    expect(capped.value).toEqual({ content: "small" });
  });

  it("truncates an oversized result and says how big it really was", () => {
    const huge = { content: "x".repeat(WEBMCP_RESULT_CAP_BYTES + 5_000) };
    const capped = capResult(huge);
    expect(capped.truncated).toBe(true);
    expect(capped.bytes).toBeGreaterThan(WEBMCP_RESULT_CAP_BYTES);
    expect(String(capped.value)).toContain("truncated");
    expect(String(capped.value)).toContain(String(capped.bytes));
  });

  it("keeps the truncated value within the cap, marker included", () => {
    const capped = capResult({
      content: "x".repeat(WEBMCP_RESULT_CAP_BYTES * 2),
    });
    expect(capped.truncated).toBe(true);
    // Reserving no room for the marker would produce "capped" output that still
    // exceeds the cap, which defeats the point of having one.
    expect(Buffer.byteLength(String(capped.value), "utf8")).toBeLessThanOrEqual(
      WEBMCP_RESULT_CAP_BYTES,
    );
  });

  it("cuts multibyte output on a character boundary", () => {
    // A naive byte slice splits a multi-byte character and leaves a replacement
    // character at the end of every truncated non-ASCII result.
    const capped = capResult({ content: "🛒".repeat(WEBMCP_RESULT_CAP_BYTES) });
    const text = String(capped.value);
    expect(capped.truncated).toBe(true);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(
      WEBMCP_RESULT_CAP_BYTES,
    );
    expect(text).not.toContain("�");
  });

  it("survives output that cannot be serialized at all", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    // Output comes from an untrusted page; a throw here would take down the
    // invocation path rather than the tool call.
    expect(() => capResult(cyclic)).not.toThrow();
    expect(capResult(cyclic).truncated).toBe(true);
  });

  it("records truncation on the settled activity entry", async () => {
    const { runtime, session, activity } = makeRuntime();
    session.emitTools([fakeTool()]);
    session.hangOnInvoke = true;
    const { settled } = runtime.invoke(
      "https://example.test::echo",
      {},
      "manual",
    );
    await vi.waitFor(() => expect(session.invocations).toHaveLength(1));
    session.pending?.resolve({
      output: "y".repeat(WEBMCP_RESULT_CAP_BYTES + 100),
    });
    await settled;

    await vi.waitFor(() => {
      const done = entryOfKind(activity(), "invocation_settled");
      expect(done?.outputTruncated).toBe(true);
      expect(done?.outputBytes).toBeGreaterThan(WEBMCP_RESULT_CAP_BYTES);
    });
  });
});

describe("session lifecycle events", () => {
  it("records a popup without closing it", () => {
    const { session, activity } = makeRuntime();
    session.callbacks.onPopupOpened("https://accounts.test/oauth");
    const popup = entryOfKind(activity(), "popup_opened");
    expect(popup?.url).toBe("https://accounts.test/oauth");
    expect(popup?.note).toMatch(/sign-in/i);
  });

  it("fails pending work when the browser dies", async () => {
    const { runtime, session } = makeRuntime();
    session.emitTools([fakeTool()]);
    session.hangOnInvoke = true;
    const { settled } = runtime.invoke(
      "https://example.test::echo",
      {},
      "manual",
    );
    await vi.waitFor(() => expect(session.invocations).toHaveLength(1));

    session.callbacks.onCrashed("The browser page crashed.");
    // A dead browser can never settle this; leaving it pending would hang the
    // caller forever.
    await expect(settled).rejects.toThrow();
  });
});

describe("viewport frames", () => {
  it("publishes a frame event with the session's own seq", () => {
    const { session, events } = makeRuntime();
    session.emitFrame({ data: "paint-1", deviceWidth: 800, deviceHeight: 600 });

    const frames = events.filter(
      (e): e is Extract<WebMcpEvent, { type: "frame" }> => e.type === "frame",
    );
    expect(frames).toHaveLength(1);
    expect(frames[0].frame).toMatchObject({
      data: "paint-1",
      deviceWidth: 800,
      deviceHeight: 600,
    });
    // Stamped from the same counter as everything else, so a replayed frame
    // sorts into place beside the events around it rather than to one end.
    expect(frames[0].seq).toBeGreaterThan(0);
    expect(events.every((e, i) => i === 0 || e.seq > events[i - 1].seq)).toBe(
      true,
    );
  });

  it("writes no timeline entry for a frame", () => {
    const { session, activity } = makeRuntime();
    const before = activity().length;
    for (let i = 0; i < 10; i++) session.emitFrame();
    // Frames are transient. The timeline is the record the session exists to
    // produce, and it must not be a filmstrip.
    expect(activity()).toHaveLength(before);
  });

  it("does not tick the idle clock for a frame", () => {
    const { session, onActivity } = makeRuntime();
    onActivity.mockClear();
    for (let i = 0; i < 10; i++) session.emitFrame();
    // A page with a CSS spinner paints forever. Ticking the idle clock from a
    // paint would make every abandoned animated page unreapable.
    expect(onActivity).not.toHaveBeenCalled();
  });

  it("ticks the idle clock when asked for frames, but not when they stop", async () => {
    const { runtime, session, onActivity } = makeRuntime();
    onActivity.mockClear();

    expect(await runtime.setScreencast(true)).toBe(true);
    // Asking for frames is a person opening the pane — interest worth
    // postponing a reap for, unlike the frames themselves.
    expect(onActivity).toHaveBeenCalledTimes(1);

    expect(await runtime.setScreencast(false)).toBe(false);
    expect(session.screencastCalls).toEqual([true, false]);
    // Withdrawing them is the opposite, and the client withdraws on EVERY
    // visibility change: ticking here would let a flapping background tab keep
    // an abandoned session alive indefinitely.
    expect(onActivity).toHaveBeenCalledTimes(1);
  });

  it("reports a browser that cannot screencast, so the caller can fall back", async () => {
    const { runtime, session } = makeRuntime();
    session.screencastAvailable = false;
    // A 200 with `streaming: false`, not an error: the request was fine and
    // this browser simply cannot do it. The client polls screenshots instead of
    // waiting forever for frames that will never come.
    expect(await runtime.setScreencast(true)).toBe(false);
  });

  it("forgets the retained frame once the stream stops", async () => {
    const { runtime, session } = makeRuntime();
    await runtime.setScreencast(true);
    session.emitFrame({ data: "paint" });
    expect(runtime.hub.buffered().some((e) => e.type === "frame")).toBe(true);

    await runtime.setScreencast(false);
    // Replay promises a reconnecting client the CURRENT paint. A frame from a
    // stream nobody is running any more is not that.
    expect(runtime.hub.buffered().some((e) => e.type === "frame")).toBe(false);
  });

  it("forgets the retained frame when the page navigates away", () => {
    const { runtime, session } = makeRuntime();
    session.emitFrame({ data: "old-page" });
    expect(runtime.hub.buffered().some((e) => e.type === "frame")).toBe(true);

    session.callbacks.onNavigated(
      "https://elsewhere.test/",
      "https://elsewhere.test",
    );

    // Same class of lie as serving the previous page's tools: the retained
    // picture depicts a page that is gone, and replay would hand it to a
    // reconnecting client as the current one.
    expect(runtime.hub.buffered().some((e) => e.type === "frame")).toBe(false);
  });

  it("refuses setScreencast before a browser is attached", async () => {
    const runtime = new WebMcpSessionRuntime("https://example.test/");
    await expect(runtime.setScreencast(true)).rejects.toThrow(/not ready/i);
  });

  it("forwards a transport's dropped frame to the browser", () => {
    const { runtime, session, onActivity } = makeRuntime();
    runtime.noteFramePressure();
    runtime.noteFramePressure();

    // The provider owns the quality ladder; the transports are the only thing
    // that can see a frame fail to land. This is the whole funnel.
    expect(session.pressureEvents).toBe(2);
    // NOT activity: a struggling link is not somebody using the session, and
    // ticking the idle clock from it would hold an abandoned tab open for as
    // long as its network stayed bad.
    expect(onActivity).not.toHaveBeenCalled();
  });

  it("says nothing to a browser that is not there, or cannot listen", () => {
    // Between `reserve` and `attach`, and for every provider that has no
    // adaptive stream to steer. A hot-path diagnostic must never be the thing
    // that throws.
    const runtime = new WebMcpSessionRuntime("https://example.test/");
    expect(() => runtime.noteFramePressure()).not.toThrow();

    const { runtime: attached, session } = makeRuntime();
    (session as { noteFramePressure?: () => void }).noteFramePressure =
      undefined;
    expect(() => attached.noteFramePressure()).not.toThrow();
  });

  it("republishes the session when the stream's quality changes", () => {
    const { session, events } = makeRuntime();
    session.emitStreamQuality(60);

    const published = events.filter(
      (e): e is Extract<WebMcpEvent, { type: "session" }> =>
        e.type === "session",
    );
    // The picture getting worse is a FACT the UI can show; without it, "the
    // link is struggling" and "the page is broken" look identical.
    expect(published.at(-1)?.session.streamQuality).toBe(60);

    // Re-reporting the same rung — which a restart does — is not news.
    const before = published.length;
    session.emitStreamQuality(60);
    expect(events.filter((e) => e.type === "session").length - before).toBe(0);

    session.emitStreamQuality(45);
    expect(
      events
        .filter(
          (e): e is Extract<WebMcpEvent, { type: "session" }> =>
            e.type === "session",
        )
        .at(-1)?.session.streamQuality,
    ).toBe(45);
  });

  it("omits the quality entirely for a provider that never reports one", () => {
    const { runtime } = makeRuntime();
    // Every provider but the local one: an absent field, not a guess at what
    // their stream might be doing.
    expect(runtime.toPublic()).not.toHaveProperty("streamQuality");
  });
});

describe("input forwarding", () => {
  it("hands the batch to the browser and ticks the idle clock", async () => {
    const { runtime, session, onActivity } = makeRuntime();
    onActivity.mockClear();

    await runtime.dispatchInput([
      { kind: "mouse_down", x: 5, y: 6, button: "left" },
      { kind: "mouse_up", x: 5, y: 6, button: "left" },
    ]);

    expect(session.inputBatches[0].map((event) => event.kind)).toEqual([
      "mouse_down",
      "mouse_up",
    ]);
    // A human working the pane is the clearest possible signal that the session
    // is in use; reaping it out from under them would be the worst version of
    // this feature.
    expect(onActivity).toHaveBeenCalledTimes(1);
  });

  it("writes no timeline entry for input", async () => {
    const { runtime, activity } = makeRuntime();
    const before = activity().length;
    for (let i = 0; i < 20; i++) {
      await runtime.dispatchInput([{ kind: "mouse_move", x: i, y: i }]);
    }
    // The timeline records protocol happenings. Input's CONSEQUENCES already
    // produce entries — a click that navigates writes `navigated` — so logging
    // the clicks themselves would bury those under a mouse trail.
    expect(activity()).toHaveLength(before);
  });

  it("refuses input before a browser is attached", async () => {
    const runtime = new WebMcpSessionRuntime("https://example.test/");
    await expect(
      runtime.dispatchInput([{ kind: "mouse_move", x: 1, y: 1 }]),
    ).rejects.toThrow(/not ready/i);
  });
});
