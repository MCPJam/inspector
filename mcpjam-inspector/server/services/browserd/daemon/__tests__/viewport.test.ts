import { describe, expect, it } from "vitest";
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
    expect(methods().filter((m) => m === "Page.startScreencast")).toHaveLength(1);

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
    const { viewport, frames, emitFrame, time } = make({ maxFrameBytes: 1_000 });
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
    const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
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
