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
