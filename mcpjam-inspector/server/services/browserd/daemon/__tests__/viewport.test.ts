import { describe, expect, it, vi } from "vitest";
import { createTabViewport, type ViewportFrame } from "../viewport";
import type { CdpLike } from "../webmcp-bridge";

/** A CDP session that records what was sent and can push events back. */
function fakeCdp() {
  const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const handlers = new Map<string, (payload: unknown) => void>();
  const cdp: CdpLike = {
    async send(method, params) {
      sent.push({ method, ...(params ? { params } : {}) });
      return {};
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
  };
  return {
    cdp,
    sent,
    methods: () => sent.map((s) => s.method),
    emitNavigation(frame: { parentId?: string } = {}) {
      handlers.get("Page.frameNavigated")?.({ frame });
    },
    emitFrame(data: string, sessionId = 1) {
      handlers.get("Page.screencastFrame")?.({ data, sessionId });
    },
  };
}

/** A one-pixel JPEG, so `readJpegDimensions` has a real SOF to read. */
const JPEG_1PX =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
  "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
  "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

function clock() {
  let now = 0;
  const timers: Array<{ at: number; fn: () => void }> = [];
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const timer = { at: now + ms, fn };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle: unknown) => {
      const i = timers.indexOf(handle as { at: number; fn: () => void });
      if (i >= 0) timers.splice(i, 1);
    },
    advance(ms: number) {
      now += ms;
      for (const timer of [...timers]) {
        if (timer.at <= now) {
          timers.splice(timers.indexOf(timer), 1);
          timer.fn();
        }
      }
    },
  };
}

function make(over: Record<string, unknown> = {}) {
  const fake = fakeCdp();
  const time = clock();
  const frames: ViewportFrame[] = [];
  const viewport = createTabViewport(fake.cdp, {
    surface: { width: 1024, height: 768 },
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    ...over,
  });
  return { ...fake, viewport, frames, time };
}

describe("tab viewport", () => {
  it("acks a frame BEFORE anything else can drop it", async () => {
    // Chromium sends the next frame only once this one is acknowledged, so an
    // ack that waits on consumption lets a slow consumer starve the stream.
    const { viewport, cdp, methods, emitFrame } = make();
    void viewport.subscribe(() => {});
    await Promise.resolve();

    // Oversized: dropped, but still acked.
    emitFrame("x".repeat(2_000_000));
    await Promise.resolve();
    expect(methods()).toContain("Page.screencastFrameAck");
    expect(cdp).toBeDefined();
  });

  it("paints only while somebody is watching", async () => {
    const { viewport, methods } = make();
    const stop = viewport.subscribe(() => {});
    await Promise.resolve();
    expect(methods()).toContain("Page.startScreencast");

    stop();
    await Promise.resolve();
    expect(methods()).toContain("Page.stopScreencast");
  });

  it("starts once for many watchers, and stops after the last leaves", async () => {
    const { viewport, methods } = make();
    const a = viewport.subscribe(() => {});
    const b = viewport.subscribe(() => {});
    await Promise.resolve();
    expect(methods().filter((m) => m === "Page.startScreencast")).toHaveLength(
      1,
    );

    a();
    await Promise.resolve();
    expect(methods()).not.toContain("Page.stopScreencast");
    b();
    await Promise.resolve();
    expect(methods()).toContain("Page.stopScreencast");
  });

  it("drops a frame identical to the one before it", async () => {
    // Every screenshot the model takes induces a compositor frame that comes
    // back byte-for-byte; publishing it would make each capture induce the
    // next one.
    const { viewport, frames, emitFrame, time } = make();
    viewport.subscribe((f) => frames.push(f));
    await Promise.resolve();

    emitFrame(JPEG_1PX);
    time.advance(200);
    emitFrame(JPEG_1PX);
    time.advance(200);
    expect(frames).toHaveLength(1);
  });

  it("always delivers the LAST paint of a burst", async () => {
    // The final frame is the one that shows what the page ended up looking
    // like. A plain throttle drops exactly that one.
    const { viewport, frames, emitFrame, time } = make();
    viewport.subscribe((f) => frames.push(f));
    await Promise.resolve();

    emitFrame(`${JPEG_1PX}A`);
    emitFrame(`${JPEG_1PX}B`);
    emitFrame(`${JPEG_1PX}C`);
    time.advance(500);

    expect(frames.at(-1)?.data).toBe(`${JPEG_1PX}C`);
  });

  it("refuses to publish a frame too large to carry", async () => {
    const { viewport, frames, emitFrame, time } = make({
      maxFrameBytes: 1_000,
    });
    viewport.subscribe((f) => frames.push(f));
    await Promise.resolve();
    emitFrame("x".repeat(10_000));
    time.advance(500);
    expect(frames).toHaveLength(0);
  });

  it("reads a frame's geometry from the picture, not from the metadata", async () => {
    // The client scales clicks against what a frame claims to be; CDP's
    // metadata reports DIP whatever the device scale is.
    const { viewport, frames, emitFrame, time } = make();
    viewport.subscribe((f) => frames.push(f));
    await Promise.resolve();
    emitFrame(JPEG_1PX);
    time.advance(200);
    expect(frames[0]).toMatchObject({ deviceWidth: 1, deviceHeight: 1 });
  });

  it("forwards a click, a wheel and typed text as CDP input", async () => {
    const { viewport, sent } = make();
    await viewport.dispatchInput([
      { type: "mouse_move", x: 10, y: 20 },
      { type: "mouse_down", x: 10, y: 20, button: "left" },
      { type: "mouse_up", x: 10, y: 20, button: "left" },
      { type: "wheel", x: 10, y: 20, deltaX: 0, deltaY: 120 },
      { type: "text", text: "hunter2" },
      { type: "key_down", key: "Enter" },
    ]);

    expect(sent.map((s) => s.method)).toEqual([
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
      "Input.insertText",
      "Input.dispatchKeyEvent",
    ]);
    expect(sent[5].params).toMatchObject({
      key: "Enter",
      windowsVirtualKeyCode: 13,
    });
  });

  it("lets one bad event through without swallowing the next", async () => {
    const fake = fakeCdp();
    let calls = 0;
    const cdp: CdpLike = {
      async send(method, params) {
        calls += 1;
        if (calls === 1) throw new Error("exotic key");
        return fake.cdp.send(method, params);
      },
      on: fake.cdp.on,
    };
    const viewport = createTabViewport(cdp, {
      surface: { width: 1024, height: 768 },
    });
    await viewport.dispatchInput([
      { type: "key_down", key: "Unidentified" },
      { type: "mouse_down", x: 1, y: 1, button: "left" },
    ]);
    expect(fake.methods()).toEqual(["Input.dispatchMouseEvent"]);
  });
});

describe("createTabViewport — the button mask Chromium actually reads", () => {
  function cdpRecorder() {
    const sent: Array<{ method: string; params?: Record<string, unknown> }> =
      [];
    const handlers = new Map<string, (p: unknown) => void>();
    const cdp: CdpLike = {
      async send(method, params) {
        sent.push({ method, ...(params ? { params } : {}) });
        return {};
      },
      on(event, handler) {
        handlers.set(event, handler);
      },
    };
    return { cdp, sent };
  }

  function mouseEvents(sent: Array<{ method: string; params?: any }>) {
    return sent
      .filter((s) => s.method === "Input.dispatchMouseEvent")
      .map((s) => ({ type: s.params?.type, buttons: s.params?.buttons }));
  }

  it("releases the button it is releasing", async () => {
    // `buttons` is the mask of buttons STILL HELD. Sending the released
    // button's bit on mouseReleased leaves Chromium believing the drag never
    // ended, which strands the page mid-selection.
    const { cdp, sent } = cdpRecorder();
    const viewport = createTabViewport(cdp, {
      surface: { width: 100, height: 100 },
    });

    await viewport.dispatchInput([
      { type: "mouse_down", x: 1, y: 1, button: "left" },
      { type: "mouse_move", x: 5, y: 5 },
      { type: "mouse_up", x: 5, y: 5, button: "left" },
      { type: "mouse_move", x: 9, y: 9 },
    ]);

    expect(mouseEvents(sent)).toEqual([
      { type: "mousePressed", buttons: 1 },
      // A move mid-drag must carry the held button, or nothing is dragged.
      { type: "mouseMoved", buttons: 1 },
      { type: "mouseReleased", buttons: 0 },
      { type: "mouseMoved", buttons: 0 },
    ]);
  });

  it("keeps a second button held while the first is released", async () => {
    const { cdp, sent } = cdpRecorder();
    const viewport = createTabViewport(cdp, {
      surface: { width: 100, height: 100 },
    });

    await viewport.dispatchInput([
      { type: "mouse_down", x: 1, y: 1, button: "left" },
      { type: "mouse_down", x: 1, y: 1, button: "right" },
      { type: "mouse_up", x: 1, y: 1, button: "left" },
    ]);

    expect(mouseEvents(sent).map((e) => e.buttons)).toEqual([1, 3, 2]);
  });
});

describe("createTabViewport — a stale start must not silence the new stream", () => {
  it("lets only the current start/stop pair decide whether it is streaming", async () => {
    // A watcher leaves and comes straight back. The first `startScreencast` is
    // still in flight and about to fail; its handler used to clear `streaming`
    // for the stream that replaced it, leaving the live watcher frozen.
    const pending: Array<{ reject: (e: unknown) => void }> = [];
    const sent: string[] = [];
    const handlers = new Map<string, (p: unknown) => void>();
    const cdp: CdpLike = {
      send(method) {
        sent.push(method);
        if (method === "Page.startScreencast" && pending.length === 0) {
          return new Promise((_resolve, reject) => pending.push({ reject }));
        }
        return Promise.resolve({});
      },
      on(event, handler) {
        handlers.set(event, handler);
      },
    };

    const viewport = createTabViewport(cdp, {
      surface: { width: 100, height: 100 },
    });
    const frames: ViewportFrame[] = [];

    const first = viewport.subscribe(() => {});
    first();
    viewport.subscribe((f) => frames.push(f));
    // The first attempt now fails, after the second has already started.
    pending[0]?.reject(new Error("target closed"));
    await Promise.resolve();
    await Promise.resolve();

    handlers.get("Page.screencastFrame")?.({
      data: Buffer.from([0xff, 0xd8, 0xff]).toString("base64"),
      sessionId: 1,
    });

    expect(sent.filter((m) => m === "Page.startScreencast")).toHaveLength(2);
    expect(frames.length).toBeGreaterThan(0);
  });
});

describe("createTabViewport — the mask does not outlive the hand that set it", () => {
  function recorder(fail?: (method: string, n: number) => boolean) {
    const sent: Array<{ method: string; params?: any }> = [];
    let n = 0;
    const cdp: CdpLike = {
      async send(method, params) {
        n += 1;
        sent.push({ method, ...(params ? { params } : {}) });
        if (fail?.(method, n)) throw new Error("target closed");
        return {};
      },
      on() {},
    };
    return { cdp, sent };
  }
  const masks = (sent: Array<{ method: string; params?: any }>) =>
    sent
      .filter((s) => s.method === "Input.dispatchMouseEvent")
      .map((s) => s.params?.buttons);

  it("forgets a held button when the batch is refused mid-gesture", async () => {
    // The release will never arrive. A bit left set is the NEXT holder's first
    // hover reaching Chromium as a drag.
    const { cdp, sent } = recorder();
    const viewport = createTabViewport(cdp, {
      surface: { width: 100, height: 100 },
    });
    let permitted = true;

    await viewport.dispatchInput(
      [
        { type: "mouse_down", x: 1, y: 1, button: "left" },
        { type: "mouse_move", x: 2, y: 2 },
      ],
      () => permitted,
    );
    expect(masks(sent)).toEqual([1, 1]);

    // Control changes. The rest of the drag is refused...
    permitted = false;
    await viewport.dispatchInput(
      [{ type: "mouse_move", x: 3, y: 3 }],
      () => permitted,
    );

    // ...and the next holder's first move is a hover, not a drag.
    permitted = true;
    await viewport.dispatchInput(
      [{ type: "mouse_move", x: 9, y: 9 }],
      () => permitted,
    );
    expect(masks(sent).at(-1)).toBe(0);
  });

  it("does not record a button whose press Chromium never accepted", async () => {
    // `dispatchOne`'s rejection is swallowed. Committing the mask first would
    // leave us claiming a button the page is not holding.
    const { cdp, sent } = recorder(
      (method) => method === "Input.dispatchMouseEvent" && sent.length === 1,
    );
    const viewport = createTabViewport(cdp, {
      surface: { width: 100, height: 100 },
    });

    await viewport.dispatchInput([
      { type: "mouse_down", x: 1, y: 1, button: "left" },
      { type: "mouse_move", x: 2, y: 2 },
    ]);

    expect(masks(sent).at(-1)).toBe(0);
  });

  it("does not let a refused batch clear the NEXT holder's button", async () => {
    // The handoff makes this the common case, not an exotic one: the outgoing
    // holder's batch is still in flight when the incoming holder's first click
    // arrives. Interleaved, the old batch's refusal — or just its own stale
    // mask, committed after the await it was computed before — lands between
    // the new holder's press and their drag, and the person actually at the
    // keyboard watches their drag turn into a hover. Batches run one after
    // another instead, so a refusal can only clear a mask nobody has set
    // since.
    const { cdp, sent } = recorder();
    const viewport = createTabViewport(cdp, {
      surface: { width: 100, height: 100 },
    });

    // Three moves from the outgoing holder; the lease goes on the third.
    let asked = 0;
    const outgoing = viewport.dispatchInput(
      [
        { type: "mouse_move", x: 1, y: 1 },
        { type: "mouse_move", x: 2, y: 2 },
        { type: "mouse_move", x: 3, y: 3 },
      ],
      () => {
        asked += 1;
        return asked <= 2;
      },
    );

    // The incoming holder presses, then drags, while that batch is still
    // running — two requests, as the pane sends them.
    await viewport.dispatchInput([
      { type: "mouse_down", x: 9, y: 9, button: "left" },
    ]);
    await viewport.dispatchInput([{ type: "mouse_move", x: 10, y: 10 }]);
    await outgoing;

    // Their drag carries the button they are holding.
    expect(masks(sent).at(-1)).toBe(1);
  });

  it("does not hand the next person a button the last one never released", async () => {
    // The handoff that is NOT interrupted, which is the ordinary one: the
    // outgoing holder presses, the lease changes hands, and the release never
    // arrives because their pane stopped sending. Nothing was refused, so the
    // refusal path above never runs — and the bit sits in the mask until
    // somebody happens to press and release that same button. The next
    // holder's first hover reaches Chromium as a drag over a page they have
    // not touched.
    const { cdp, sent } = recorder();
    const viewport = createTabViewport(cdp, {
      surface: { width: 100, height: 100 },
    });

    await viewport.dispatchInput(
      [{ type: "mouse_down", x: 1, y: 1, button: "left" }],
      undefined,
      "rail-1",
    );
    expect(masks(sent)).toEqual([1]);

    await viewport.dispatchInput(
      [{ type: "mouse_move", x: 5, y: 5 }],
      undefined,
      "rail-2",
    );

    expect(masks(sent).at(-1)).toBe(0);
  });

  it("dispatches nothing once it has been disposed", async () => {
    // The earlier version of this test asserted on a BRAND-NEW viewport, whose
    // mask starts at 0 whether or not dispose clears anything — it passed with
    // the fix reverted. What actually needs pinning is this viewport: its page
    // is gone, its mask has been dropped, and a `mouse_move` arriving late
    // must not reach a CDP session that no longer speaks for anything.
    const { cdp, sent } = recorder();
    const viewport = createTabViewport(cdp, {
      surface: { width: 100, height: 100 },
    });
    await viewport.dispatchInput([
      { type: "mouse_down", x: 1, y: 1, button: "left" },
    ]);
    expect(masks(sent)).toEqual([1]);

    await viewport.dispose();
    await viewport.dispatchInput([{ type: "mouse_move", x: 2, y: 2 }]);

    expect(masks(sent)).toEqual([1]);
  });
});

/**
 * V-4a. Three drop paths existed and every one was silent, so a pane showing a
 * stale picture and a pane on a healthy quiet page looked identical from
 * outside the box. Each of these fails when its counter is reverted.
 */
describe("counting what the viewport threw away", () => {
  it("counts a byte-identical frame as a dedupe drop", async () => {
    const { viewport, emitFrame } = make({ minIntervalMs: 0 });
    viewport.subscribe(() => {});
    await Promise.resolve();
    emitFrame(JPEG_1PX, 1);
    emitFrame(JPEG_1PX, 2);
    const counters = viewport.counters();
    expect(counters.framesIn).toBe(2);
    expect(counters.dropped.dedupe).toBe(1);
    expect(counters.framesOut).toBe(1);
  });

  it("counts an oversized frame as its own kind of drop", async () => {
    const { viewport, emitFrame } = make({
      minIntervalMs: 0,
      maxFrameBytes: 8,
    });
    viewport.subscribe(() => {});
    await Promise.resolve();
    emitFrame(JPEG_1PX, 1);
    expect(viewport.counters().dropped.oversize).toBe(1);
    expect(viewport.counters().dropped.dedupe).toBe(0);
    expect(viewport.counters().framesOut).toBe(0);
  });

  it("counts a transport's own drop against the same viewport", () => {
    // The pacer's overwrite is one layer up, but it is the same loss and
    // belongs in the same number — one figure describes the whole way out.
    const { viewport } = make();
    viewport.noteTransportDrop();
    viewport.noteTransportDrop();
    expect(viewport.counters().dropped.pacer).toBe(2);
  });

  it("hands out a snapshot, not the live object", () => {
    const { viewport } = make();
    const first = viewport.counters();
    viewport.noteTransportDrop();
    expect(first.dropped.pacer).toBe(0);
    expect(viewport.counters().dropped.pacer).toBe(1);
  });
});

describe("shared viewport lifecycle", () => {
  it("serializes resize and restarts at the new geometry", async () => {
    const h = make();
    h.viewport.subscribe(() => {});
    expect(await h.viewport.ready()).toBe(true);
    let release!: () => void;
    const applied: number[] = [];
    let entered!: () => void;
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = h.viewport.resize({ width: 600, height: 700 }, async () => {
      applied.push(600);
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const second = h.viewport.resize({ width: 800, height: 500 }, async () => {
      applied.push(800);
    });
    await entering;
    expect(applied).toEqual([600]);
    release();
    await Promise.all([first, second]);
    expect(applied).toEqual([600, 800]);
    expect(
      h.sent.filter((call) => call.method === "Page.startScreencast").at(-1)
        ?.params,
    ).toMatchObject({ maxWidth: 800, maxHeight: 500, quality: 85 });
    await h.viewport.dispose();
  });

  it("restarts after a rejected resize and never restarts after disposal", async () => {
    const h = make();
    h.viewport.subscribe(() => {});
    await h.viewport.ready();
    await expect(
      h.viewport.resize({ width: 600, height: 700 }, async () => {
        throw new Error("closed");
      }),
    ).rejects.toThrow("closed");
    expect(await h.viewport.ready()).toBe(true);
    await h.viewport.dispose();
    const count = h.methods().length;
    await h.viewport.resize({ width: 800, height: 500 });
    expect(h.methods()).toHaveLength(count);
    expect(await h.viewport.ready()).toBe(false);
  });

  it("invalidates a deduplicated frame when navigation reuses the same pixels", async () => {
    const h = make();
    h.viewport.subscribe((frame) => h.frames.push(frame));
    await h.viewport.ready();
    h.emitFrame(JPEG_1PX);
    h.emitFrame(JPEG_1PX);
    expect(h.frames).toHaveLength(1);
    h.viewport.invalidate();
    h.time.advance(100);
    h.emitFrame(JPEG_1PX);
    expect(h.frames).toHaveLength(2);
    await h.viewport.dispose();
  });
});

it("reduces an oversized picture progressively and stops at the floor", async () => {
  const h = make({ maxFrameBytes: 1024 });
  h.viewport.subscribe((f) => h.frames.push(f));
  await h.viewport.ready();
  h.emitFrame("x".repeat(2048));
  await h.viewport.ready();
  expect(
    h.sent
      .filter((c) => c.method === "Page.startScreencast")
      .map((c) => c.params?.quality),
  ).toEqual([85, 75]);
  h.emitFrame(JPEG_1PX);
  expect(h.frames).toHaveLength(1);
  h.emitFrame("y".repeat(2048));
  await h.viewport.ready();
  expect(
    h.sent.filter((c) => c.method === "Page.startScreencast"),
  ).toHaveLength(3);
  for (const suffix of ["a", "b", "c", "d"]) {
    h.emitFrame(suffix.repeat(2048));
    await h.viewport.ready();
  }
  expect(h.viewport.counters().jpeg).toMatchObject({
    quality: 40,
    reason: "jpeg_frame_limit",
  });
  expect(
    h.sent.filter((c) => c.method === "Page.startScreencast"),
  ).toHaveLength(5);
  await h.viewport.dispose();
});

it("does not restart oversize recovery after the viewer retires", async () => {
  const h = make({ maxFrameBytes: 8 });
  const unsubscribe = h.viewport.subscribe(() => {});
  await h.viewport.ready();
  h.emitFrame(JPEG_1PX);
  unsubscribe();
  await h.viewport.dispose();
  await h.viewport.ready();
  expect(
    h.sent.filter((c) => c.method === "Page.startScreencast"),
  ).toHaveLength(1);
});

it("defers first-subscriber startup until all queued viewport changes finish", async () => {
  const h = make();
  let release!: () => void;
  let entered!: () => void;
  const applying = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = h.viewport.resize({ width: 600, height: 700 }, async () => {
    entered();
    await gate;
  });
  const second = h.viewport.resize({ width: 800, height: 500 });
  await applying;
  h.viewport.subscribe(() => {});
  const ready = h.viewport.ready();
  expect(h.methods()).not.toContain("Page.startScreencast");
  release();
  await Promise.all([first, second]);
  expect(await ready).toBe(true);
  expect(
    h.sent
      .filter((c) => c.method === "Page.startScreencast")
      .map((c) => c.params),
  ).toEqual([expect.objectContaining({ maxWidth: 800, maxHeight: 500 })]);
  await h.viewport.dispose();
});

it("releases resize ownership after a failed apply and after disposal", async () => {
  const h = make();
  let release!: () => void;
  let entered!: () => void;
  const applying = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const resizing = h.viewport.resize({ width: 600, height: 700 }, async () => {
    entered();
    await gate;
    throw new Error("closed");
  });
  const rejected = expect(resizing).rejects.toThrow("closed");
  await applying;
  h.viewport.subscribe(() => {});
  await h.viewport.dispose();
  release();
  await rejected;
  expect(await h.viewport.ready()).toBe(false);
  expect(h.methods()).not.toContain("Page.startScreencast");
});

describe("JPEG quality recovery", () => {
  it("recovers on a static page and backs off a failed probe", async () => {
    const h = make({ maxFrameBytes: 1024 });
    h.viewport.subscribe((f) => h.frames.push(f));
    await h.viewport.ready();
    h.emitFrame("x".repeat(2048));
    await h.viewport.ready();
    h.emitFrame(JPEG_1PX);
    h.time.advance(10_000);
    await h.viewport.ready();
    expect(h.viewport.counters().jpeg?.quality).toBe(85);
    h.emitFrame("x".repeat(2048));
    await h.viewport.ready();
    h.emitFrame(JPEG_1PX);
    h.time.advance(10_000);
    await h.viewport.ready();
    expect(h.viewport.counters().jpeg?.quality).toBe(75);
    h.time.advance(10_000);
    await h.viewport.ready();
    h.emitFrame(JPEG_1PX);
    expect(h.viewport.counters().jpeg?.quality).toBe(85);
    await h.viewport.dispose();
  });

  it("uses the smallest active subscriber limit and filters old in-flight frames", async () => {
    const h = make();
    h.viewport.subscribe((f) => h.frames.push(f), 2 * 1024 * 1024);
    await h.viewport.ready();
    const large = "x".repeat(400_000);
    h.emitFrame(large);
    expect(h.frames).toHaveLength(1);
    const legacyFrames: ViewportFrame[] = [];
    const leave = h.viewport.subscribe((f) => legacyFrames.push(f));
    h.emitFrame("y".repeat(400_000));
    expect(legacyFrames).toHaveLength(0);
    await h.viewport.ready();
    expect(h.viewport.counters().jpeg?.maxFrameBytes).toBe(256 * 1024);
    leave();
    await h.viewport.ready();
    expect(h.viewport.counters().jpeg).toMatchObject({
      maxFrameBytes: 2 * 1024 * 1024,
      quality: 85,
    });
    await h.viewport.dispose();
  });

  it("cancels a static recovery probe after the last viewer leaves", async () => {
    const h = make({ maxFrameBytes: 1024 });
    const leave = h.viewport.subscribe(() => {});
    await h.viewport.ready();
    h.emitFrame("x".repeat(2048));
    await h.viewport.ready();
    h.emitFrame(JPEG_1PX);
    leave();
    await h.viewport.ready();
    const count = h.sent.length;
    h.time.advance(60_000);
    await h.viewport.ready();
    expect(h.sent).toHaveLength(count);
    await h.viewport.dispose();
  });
});

it("resets capture quality on main-frame navigation, not an iframe navigation", async () => {
  const h = make({ maxFrameBytes: 1024 });
  h.viewport.subscribe(() => {});
  await h.viewport.ready();
  h.emitFrame("x".repeat(2048));
  await h.viewport.ready();
  h.emitNavigation({ parentId: "main" });
  await h.viewport.ready();
  expect(h.viewport.counters().jpeg?.quality).toBe(75);
  h.emitNavigation();
  await h.viewport.ready();
  expect(h.viewport.counters().jpeg?.quality).toBe(85);
  await h.viewport.dispose();
});

it("does not block context teardown on an unanswered stopScreencast", async () => {
  vi.useFakeTimers();
  try {
    const fake = fakeCdp();
    const send = fake.cdp.send.bind(fake.cdp);
    fake.cdp.send = (method, params) => method === "Page.stopScreencast" ? new Promise(() => {}) : send(method, params);
    const viewport = createTabViewport(fake.cdp, { surface: { width: 800, height: 600 } });
    viewport.subscribe(() => {});
    await Promise.resolve();
    const disposed = viewport.dispose();
    await vi.advanceTimersByTimeAsync(1_000);
    await disposed;
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
