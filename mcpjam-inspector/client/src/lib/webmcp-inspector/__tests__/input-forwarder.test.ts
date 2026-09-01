/**
 * The forwarder's failures are all of the "it clicked the wrong thing" family,
 * which look like a broken page rather than a broken mapping. So the scaling is
 * pinned at the corners and under letterboxing in both directions, and the
 * batching is pinned on the property that matters: a click is never delayed.
 */
import { describe, expect, it } from "vitest";
import {
  buttonOf,
  createInputForwarder,
  cutBefore,
  modifiersOf,
  toFrameCoordinates,
  type ViewportGeometry,
} from "../input-forwarder";
import type { WebMcpInputEvent } from "@/shared/webmcp-inspector-protocol";

function geometry(
  rect: Partial<ViewportGeometry["rect"]> = {},
  frame: Partial<ViewportGeometry["frame"]> = {},
): ViewportGeometry {
  return {
    rect: { left: 0, top: 0, width: 1280, height: 800, ...rect },
    frame: { width: 1280, height: 800, ...frame },
  };
}

function pointer(overrides: Record<string, unknown> = {}) {
  return {
    clientX: 0,
    clientY: 0,
    button: 0,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  } as never;
}

describe("toFrameCoordinates", () => {
  it("maps one-to-one when the pane is exactly the frame", () => {
    const g = geometry();
    expect(toFrameCoordinates(0, 0, g)).toEqual({ x: 0, y: 0 });
    expect(toFrameCoordinates(640, 400, g)).toEqual({ x: 640, y: 400 });
    // The far corner lands on the last addressable pixel, not one past it.
    expect(toFrameCoordinates(1280, 800, g)).toEqual({ x: 1279, y: 799 });
  });

  it("scales a pane rendered at half size", () => {
    const g = geometry({ width: 640, height: 400 });
    expect(toFrameCoordinates(0, 0, g)).toEqual({ x: 0, y: 0 });
    expect(toFrameCoordinates(320, 200, g)).toEqual({ x: 640, y: 400 });
  });

  it("accounts for the pane's own offset on the screen", () => {
    const g = geometry({ left: 100, top: 50, width: 640, height: 400 });
    // The pane's top-left is at (100, 50), so a click there is the page's
    // origin — not (100, 50) on the page.
    expect(toFrameCoordinates(100, 50, g)).toEqual({ x: 0, y: 0 });
    expect(toFrameCoordinates(420, 250, g)).toEqual({ x: 640, y: 400 });
  });

  it("skips the letterbox bars when the pane is too tall", () => {
    // 1280x800 inside a 640x600 box fits at 640x400, leaving 100px bars.
    const g = geometry({ width: 640, height: 600 });
    // Inside the top bar: the person clicked background, not the page.
    expect(toFrameCoordinates(320, 50, g)).toBeUndefined();
    // The picture's own top edge.
    expect(toFrameCoordinates(320, 100, g)).toEqual({ x: 640, y: 0 });
    expect(toFrameCoordinates(320, 300, g)).toEqual({ x: 640, y: 400 });
    // Inside the bottom bar.
    expect(toFrameCoordinates(320, 550, g)).toBeUndefined();
  });

  it("skips the letterbox bars when the pane is too wide", () => {
    // 1280x800 inside an 800x400 box fits at 640x400, leaving 80px bars.
    const g = geometry({ width: 800, height: 400 });
    expect(toFrameCoordinates(40, 200, g)).toBeUndefined();
    expect(toFrameCoordinates(80, 200, g)).toEqual({ x: 0, y: 400 });
    expect(toFrameCoordinates(760, 200, g)).toBeUndefined();
  });

  it("refuses a degenerate box rather than dividing by zero", () => {
    expect(toFrameCoordinates(10, 10, geometry({ width: 0 }))).toBeUndefined();
    expect(
      toFrameCoordinates(10, 10, geometry({}, { height: 0 })),
    ).toBeUndefined();
  });

  it("uses the FRAME's dimensions, not a fixed viewport", () => {
    // A frame captured at a different surface size: the scale has to come from
    // the picture on screen, or every click after a resize is offset.
    const g = geometry(
      { width: 640, height: 480 },
      { width: 640, height: 480 },
    );
    expect(toFrameCoordinates(320, 240, g)).toEqual({ x: 320, y: 240 });
  });
});

describe("modifiersOf / buttonOf", () => {
  it("omits modifiers that are not held", () => {
    expect(
      modifiersOf({
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
      }),
    ).toBeUndefined();
    expect(
      modifiersOf({
        altKey: false,
        ctrlKey: true,
        metaKey: false,
        shiftKey: true,
      }),
    ).toEqual({ ctrl: true, shift: true });
  });

  it("names the DOM button numbers", () => {
    expect(buttonOf(0)).toBe("left");
    expect(buttonOf(1)).toBe("middle");
    expect(buttonOf(2)).toBe("right");
  });
});

/**
 * A forwarder with hand-cranked timers and a fixed pane.
 *
 * `deferSends` makes every `send` return a promise the test settles by hand,
 * which is what makes "in flight" observable at all: the wheel path's whole
 * behaviour is defined in terms of whether a request is still on the wire.
 */
function harness(
  options: {
    geometry?: ViewportGeometry | undefined;
    deferSends?: boolean;
  } = {},
) {
  const sent: WebMcpInputEvent[][] = [];
  const timers = new Map<number, () => void>();
  const settlers: Array<{ resolve: () => void; reject: () => void }> = [];
  let nextHandle = 1;

  const forwarder = createInputForwarder({
    send: (events) => {
      sent.push(events);
      if (!options.deferSends) return;
      return new Promise<void>((resolve, reject) => {
        settlers.push({ resolve, reject: () => reject(new Error("failed")) });
      });
    },
    geometry: () =>
      "geometry" in options ? options.geometry : geometry({}, {}),
    flushMs: 50,
    setTimer: (fn) => {
      const handle = nextHandle++;
      timers.set(handle, fn);
      return handle;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
  });

  return {
    forwarder,
    sent,
    /** Settle the oldest outstanding send, and let its follow-up run. */
    async settleOldest(outcome: "resolve" | "reject" = "resolve") {
      settlers.shift()?.[outcome]();
      // The forwarder flushes from a `.then`, so the queued microtask has to
      // run before the effect is observable.
      await Promise.resolve();
      await Promise.resolve();
    },
    outstanding: () => settlers.length,
    /** Fire every armed timer, as advancing past the flush window would. */
    runTimers() {
      for (const [handle, fn] of [...timers]) {
        timers.delete(handle);
        fn();
      }
    },
    pendingTimers: () => timers.size,
    flat: () => sent.flat(),
  };
}

function wheel(overrides: Record<string, unknown> = {}) {
  return pointer({ deltaX: 0, deltaY: 0, ...overrides });
}

/**
 * The wheel path.
 *
 * A scroll was the one discrete gesture still riding the 50ms move timer, so
 * the first turn of the wheel cost a batch window before anything moved. It is
 * also the highest-frequency input there is, which is why it cannot simply be
 * made immediate: a continuous scroll would then be one request per event,
 * piling up behind the store's serialized chain until the page scrolled
 * seconds after the person stopped.
 */
describe("createInputForwarder — wheel", () => {
  it("sends the first wheel of a gesture straight away", () => {
    const h = harness({ deferSends: true });
    h.forwarder.wheel(wheel({ clientX: 10, clientY: 20, deltaY: -120 }));
    // Synchronously, with no timer run: this is the assertion the whole change
    // exists for, and it fails on the shipped code.
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toEqual([
      { kind: "wheel", x: 10, y: 20, deltaX: 0, deltaY: -120 },
    ]);
    expect(h.pendingTimers()).toBe(0);
  });

  it("coalesces wheels arriving while a request is in flight, summing deltas", async () => {
    const h = harness({ deferSends: true });
    h.forwarder.wheel(wheel({ clientX: 10, clientY: 20, deltaY: -100 }));
    expect(h.sent).toHaveLength(1);

    h.forwarder.wheel(wheel({ clientX: 11, clientY: 21, deltaY: -10 }));
    h.forwarder.wheel(wheel({ clientX: 12, clientY: 22, deltaY: -20 }));
    h.forwarder.wheel(wheel({ clientX: 13, clientY: 23, deltaY: -30 }));
    // Nothing new goes out while one is on the wire: the flood bound is the
    // transport's real capacity, not a fixed rate.
    expect(h.sent).toHaveLength(1);

    await h.settleOldest();
    expect(h.sent).toHaveLength(2);
    // Summed, not latest-wins: scroll distance is additive, and keeping only
    // the newest would make a fast flick move the page less than a slow one.
    // The coordinate is the newest, because that is where the pointer is.
    expect(h.sent[1]).toEqual([
      { kind: "wheel", x: 13, y: 23, deltaX: 0, deltaY: -60 },
    ]);
  });

  it("never merges a ctrl-wheel with a plain one", async () => {
    const h = harness({ deferSends: true });
    h.forwarder.wheel(wheel({ deltaY: -10 }));
    h.forwarder.wheel(wheel({ deltaY: -20 }));
    h.forwarder.wheel(wheel({ deltaY: -30, ctrlKey: true }));
    h.forwarder.wheel(wheel({ deltaY: -40, ctrlKey: true }));
    await h.settleOldest();

    // A ctrl-wheel is a ZOOM. Folding it into a scroll would change what the
    // page is being asked to do — and the order between them is the gesture.
    expect(h.sent[1]).toEqual([
      { kind: "wheel", x: 0, y: 0, deltaX: 0, deltaY: -20 },
      {
        kind: "wheel",
        x: 0,
        y: 0,
        deltaX: 0,
        deltaY: -70,
        modifiers: { ctrl: true },
      },
    ]);
  });

  it("flushes a pending wheel with a mouse down, in gesture order", async () => {
    const h = harness({ deferSends: true });
    h.forwarder.wheel(wheel({ deltaY: -10 }));
    h.forwarder.wheel(wheel({ deltaY: -20 }));
    h.forwarder.mouseDown(pointer({ clientX: 5, clientY: 6 }));

    // A click is never held, and the wheel ahead of it in the buffer goes with
    // it — reordering them would click before the page had scrolled.
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]).toEqual([
      { kind: "wheel", x: 0, y: 0, deltaX: 0, deltaY: -20 },
      { kind: "mouse_down", x: 5, y: 6, button: "left" },
    ]);
  });

  it("drains the in-flight count on a rejected send", async () => {
    const h = harness({ deferSends: true });
    h.forwarder.wheel(wheel({ deltaY: -10 }));
    h.forwarder.wheel(wheel({ deltaY: -20 }));

    await h.settleOldest("reject");
    // A failed request that left the count raised would wedge the wheel path
    // for the rest of the session: every later scroll silently coalescing into
    // a batch nothing would ever flush.
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]).toEqual([
      { kind: "wheel", x: 0, y: 0, deltaX: 0, deltaY: -20 },
    ]);
  });

  it("keeps flushing across several round trips", async () => {
    const h = harness({ deferSends: true });
    h.forwarder.wheel(wheel({ deltaY: -10 }));
    h.forwarder.wheel(wheel({ deltaY: -20 }));
    await h.settleOldest();
    h.forwarder.wheel(wheel({ deltaY: -30 }));
    await h.settleOldest();
    await h.settleOldest();
    h.forwarder.wheel(wheel({ deltaY: -40 }));

    expect(h.sent.map((batch) => batch[0])).toEqual([
      { kind: "wheel", x: 0, y: 0, deltaX: 0, deltaY: -10 },
      { kind: "wheel", x: 0, y: 0, deltaX: 0, deltaY: -20 },
      { kind: "wheel", x: 0, y: 0, deltaX: 0, deltaY: -30 },
      { kind: "wheel", x: 0, y: 0, deltaX: 0, deltaY: -40 },
    ]);
  });

  it("sends every wheel immediately when the caller reports no completion", () => {
    // A `void`-returning send has no in-flight clock, so the forwarder must
    // behave as it always has rather than coalescing into a batch that only a
    // settle would release — which would be a wheel that never arrives.
    const h = harness();
    h.forwarder.wheel(wheel({ deltaY: -10 }));
    h.forwarder.wheel(wheel({ deltaY: -20 }));
    expect(h.sent).toHaveLength(2);
  });

  it("drops a settle that lands after the pane is disposed", async () => {
    const h = harness({ deferSends: true });
    h.forwarder.wheel(wheel({ deltaY: -10 }));
    h.forwarder.wheel(wheel({ deltaY: -20 }));
    h.forwarder.dispose();
    await h.settleOldest();
    // The pane is gone, so the coalesced wheel behind it goes nowhere —
    // `dispose` empties the buffer, which is what leaves the pending settle's
    // flush with nothing to send.
    expect(h.sent).toHaveLength(1);
  });
});

describe("createInputForwarder", () => {
  it("still holds mouse moves on the timer, even with an in-flight send", async () => {
    const h = harness({ deferSends: true });
    h.forwarder.mouseDown(pointer({ clientX: 1, clientY: 2 }));
    h.forwarder.mouseMove(pointer({ clientX: 10, clientY: 20 }));
    h.forwarder.mouseMove(pointer({ clientX: 11, clientY: 21 }));
    // The wheel's in-flight rule is the wheel's alone: a move trail arriving
    // 50ms late reads as nothing at all, and coalescing it against round trips
    // would make a drag jump between whole requests.
    expect(h.sent).toHaveLength(1);
    expect(h.pendingTimers()).toBe(1);

    h.runTimers();
    expect(h.sent[1]).toEqual([{ kind: "mouse_move", x: 11, y: 21 }]);
  });

  it("sends a mouse down immediately, without waiting out the window", () => {
    const h = harness();
    h.forwarder.mouseDown(pointer({ clientX: 10, clientY: 20 }));
    // A click delayed by a batch window reads as a click that did not register.
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toEqual([
      { kind: "mouse_down", x: 10, y: 20, button: "left" },
    ]);
  });

  it("coalesces moves to the latest and flushes them on the timer", () => {
    const h = harness();
    for (let i = 1; i <= 10; i++) {
      h.forwarder.mouseMove(pointer({ clientX: i * 10, clientY: i }));
    }
    expect(h.sent).toHaveLength(0);

    h.runTimers();
    // Ten pointer events, one wire event: the intermediate positions of a drag
    // are not information the page can act on, and sending them is the flood.
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toEqual([{ kind: "mouse_move", x: 100, y: 10 }]);
  });

  it("keeps a gesture's order inside one batch", () => {
    const h = harness();
    h.forwarder.mouseMove(pointer({ clientX: 5, clientY: 5 }));
    h.forwarder.mouseDown(pointer({ clientX: 6, clientY: 6 }));
    // The down flushes, and takes the buffered move with it — in order, which
    // is what makes this a click at a place rather than two unrelated events.
    expect(h.sent[0].map((event) => event.kind)).toEqual([
      "mouse_move",
      "mouse_down",
    ]);
  });

  it("carries the browser's own click count for a double-click", () => {
    const h = harness();
    h.forwarder.mouseDown(pointer({ clientX: 1, clientY: 1, detail: 2 }));
    expect(h.flat()[0]).toMatchObject({ clickCount: 2 });
    // A single click carries none: the field is only meaningful when it is > 1,
    // and always sending 1 would be noise on every event.
    h.forwarder.mouseDown(pointer({ clientX: 1, clientY: 1, detail: 1 }));
    expect(h.flat()[1]).not.toHaveProperty("clickCount");
  });

  it("releases keys still held when focus leaves", () => {
    const h = harness();
    h.forwarder.keyDown({
      key: "Shift",
      altKey: false,
      ctrlKey: false,
      metaKey: true,
      shiftKey: true,
    });
    h.sent.length = 0;

    h.forwarder.releaseHeld();
    // The page never learns that focus left this pane, so a modifier held at
    // that moment would stay held in it and turn every later click into a
    // shift-click.
    expect(h.flat()).toEqual([{ kind: "key_up", key: "Shift" }]);
  });

  it("releases a button still held when focus leaves mid-drag", () => {
    const h = harness();
    h.forwarder.mouseDown(pointer({ clientX: 1, clientY: 1 }));
    h.sent.length = 0;
    h.forwarder.releaseHeld();
    // At the last point the pointer was actually over.
    expect(h.flat()).toEqual([
      { kind: "mouse_up", x: 1, y: 1, button: "left" },
    ]);
  });

  it("releases nothing once the key has been let go normally", () => {
    const h = harness();
    const key = {
      key: "a",
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    };
    h.forwarder.keyDown(key);
    h.forwarder.keyUp(key);
    h.sent.length = 0;
    h.forwarder.releaseHeld();
    expect(h.sent).toHaveLength(0);
  });

  it("sends pasted text as text, not as keystrokes", () => {
    const h = harness();
    h.forwarder.text("日本語 pasted");
    // Paste and IME composition have no keystrokes to replay; reconstructing
    // them would be wrong in a different way on every keyboard layout.
    expect(h.flat()).toEqual([{ kind: "text", text: "日本語 pasted" }]);
  });

  it("drops a click on a letterbox bar rather than guessing", () => {
    const h = harness({ geometry: geometry({ width: 800, height: 400 }) });
    h.forwarder.mouseDown(pointer({ clientX: 10, clientY: 200 }));
    // Clicking the bar is clicking nothing. Mapping it to the nearest edge
    // would fire on page content the person never pointed at.
    expect(h.sent).toHaveLength(0);
  });

  it("drops input when there is no geometry to scale against", () => {
    const h = harness({ geometry: undefined });
    h.forwarder.mouseMove(pointer({ clientX: 1, clientY: 1 }));
    h.forwarder.mouseDown(pointer({ clientX: 1, clientY: 1 }));
    expect(h.sent).toHaveLength(0);
  });

  it("still releases a drag that ends outside the picture", () => {
    const h = harness({ geometry: geometry({ width: 800, height: 400 }) });
    h.forwarder.mouseDown(pointer({ clientX: 400, clientY: 200 }));
    h.sent.length = 0;

    // Released over a letterbox bar. Swallowing this — as an earlier version
    // did — leaves the page believing the button is still down, so every later
    // movement reads as a continuing drag and the next click extends it.
    h.forwarder.mouseUp(pointer({ clientX: 10, clientY: 200 }));
    expect(h.flat()).toEqual([
      // At the last point INSIDE the picture, which is where the person last
      // actually pointed.
      { kind: "mouse_up", x: 640, y: 400, button: "left" },
    ]);

    // And it is no longer tracked, so the blur cleanup does not send a second.
    h.sent.length = 0;
    h.forwarder.releaseHeld();
    expect(h.sent).toHaveLength(0);
  });

  it("releases a held button where the pointer last was, not at the origin", () => {
    const h = harness();
    h.forwarder.mouseDown(pointer({ clientX: 300, clientY: 200 }));
    h.sent.length = 0;
    h.forwarder.releaseHeld();
    // Releasing at (0,0) would drag whatever was grabbed to the corner first.
    expect(h.flat()).toEqual([
      { kind: "mouse_up", x: 300, y: 200, button: "left" },
    ]);
  });

  it("ignores an auxiliary mouse button rather than clicking with it", () => {
    const h = harness();
    // Thumb buttons (back/forward) and whatever a gaming mouse reports. Folding
    // them into "left" would mutate the page in a way nobody asked for.
    h.forwarder.mouseDown(pointer({ clientX: 10, clientY: 10, button: 3 }));
    h.forwarder.mouseUp(pointer({ clientX: 10, clientY: 10, button: 4 }));
    expect(h.sent).toHaveLength(0);
    expect(buttonOf(3)).toBeUndefined();
    expect(buttonOf(4)).toBeUndefined();
  });

  it("never splits an emoji in half when chunking a paste", () => {
    const h = harness();
    // One ASCII character shifts the boundary onto a surrogate pair — every
    // emoji and every astral-plane script is one. The halves travel as separate
    // events to separate `insertText` calls, so a pair broken here reaches the
    // page as two lone surrogates and the character is LOST, not merely late.
    const long = "a" + "😀".repeat(3000);
    h.forwarder.text(long);

    const texts = h
      .flat()
      .filter((event) => event.kind === "text")
      .map((event) => (event as { text: string }).text);
    expect(texts.length).toBeGreaterThan(1);
    expect(texts.join("")).toBe(long);
    for (const chunk of texts) {
      const first = chunk.charCodeAt(0);
      const last = chunk.charCodeAt(chunk.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
    }
  });

  it("cuts before a pair rather than through it", () => {
    // The cut lands on the low half of a pair, so it backs off by one.
    expect(cutBefore("a😀b", 0, 2)).toBe(1);
    // Nothing to avoid: the cut is already on a character boundary.
    expect(cutBefore("abc", 0, 2)).toBe(2);
    // The whole rest fits.
    expect(cutBefore("ab", 0, 10)).toBe(2);
    // A cut that could make no progress takes the pair rather than looping.
    expect(cutBefore("😀😀", 0, 1)).toBe(1);
  });

  it("splits a paste too long for one protocol event", () => {
    const h = harness();
    const long = "x".repeat(4 * 1024 + 10);
    h.forwarder.text(long);
    // Sent whole, the route would refuse it and the paste would be lost
    // entirely — worse than arriving as two events.
    const texts = h.flat().filter((event) => event.kind === "text");
    expect(texts).toHaveLength(2);
    expect(
      texts.map((event) => (event as { text: string }).text).join(""),
    ).toBe(long);
  });

  it("drops the buffer and its timer on dispose", () => {
    const h = harness();
    h.forwarder.mouseMove(pointer({ clientX: 1, clientY: 1 }));
    h.forwarder.dispose();
    expect(h.pendingTimers()).toBe(0);
    h.runTimers();
    expect(h.sent).toHaveLength(0);
  });

  it("sends nothing at all for an empty flush", () => {
    const h = harness();
    h.forwarder.flush();
    // An empty batch would be a request the server has to parse and refuse.
    expect(h.sent).toHaveLength(0);
  });
});
