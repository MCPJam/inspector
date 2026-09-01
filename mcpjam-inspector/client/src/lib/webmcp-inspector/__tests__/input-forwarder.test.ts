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

/** A forwarder with hand-cranked timers and a fixed pane. */
function harness(options: { geometry?: ViewportGeometry | undefined } = {}) {
  const sent: WebMcpInputEvent[][] = [];
  const timers = new Map<number, () => void>();
  let nextHandle = 1;

  const forwarder = createInputForwarder({
    send: (events) => sent.push(events),
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

describe("createInputForwarder", () => {
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
