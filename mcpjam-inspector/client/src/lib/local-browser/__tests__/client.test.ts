import { describe, expect, it } from "vitest";
import {
  coalesceInput,
  createInputForwarder,
  INPUT_BATCH_LIMIT,
  isSecureLocalOrigin,
  modifiersOf,
  toPageCoordinates,
  type LocalBrowserInputEvent,
} from "../client";

/** An element whose rectangle a test controls. */
function image(width: number, height: number) {
  return {
    getBoundingClientRect: () =>
      ({ left: 0, top: 0, width, height }) as DOMRect,
  };
}

describe("mapping a click onto the page", () => {
  const frame = { deviceWidth: 1024, deviceHeight: 768, scale: 1 };

  it("maps a click when the picture fills the element exactly", () => {
    expect(
      toPageCoordinates({ clientX: 512, clientY: 384 }, image(1024, 768), frame),
    ).toEqual({ x: 512, y: 384 });
  });

  it("scales a click on a smaller rendering", () => {
    // Half size: the middle of the element is still the middle of the page.
    expect(
      toPageCoordinates({ clientX: 256, clientY: 192 }, image(512, 384), frame),
    ).toEqual({ x: 512, y: 384 });
  });

  it("accounts for the letterbox bars `object-contain` adds", () => {
    // A 1024x768 picture inside a 1024x968 element sits 100px from the top.
    const point = toPageCoordinates(
      { clientX: 512, clientY: 100 },
      image(1024, 968),
      frame,
    );
    expect(point).toEqual({ x: 512, y: 0 });
  });

  it("DROPS a click on a letterbox bar rather than snapping it to an edge", () => {
    // The page has nothing there; mapping it to the nearest pixel would put a
    // click somewhere the person did not aim.
    expect(
      toPageCoordinates({ clientX: 512, clientY: 10 }, image(1024, 968), frame),
    ).toBeNull();
  });

  it("reads a supersampled frame at its own scale", () => {
    // A 2x frame is 2048 device pixels of a 1024 CSS-pixel page.
    const point = toPageCoordinates(
      { clientX: 512, clientY: 384 },
      image(1024, 768),
      { deviceWidth: 2048, deviceHeight: 1536, scale: 2 },
    );
    expect(point).toEqual({ x: 512, y: 384 });
  });

  it("refuses to guess about an element with no size yet", () => {
    expect(
      toPageCoordinates({ clientX: 1, clientY: 1 }, image(0, 0), frame),
    ).toBeNull();
  });
});

describe("modifiers", () => {
  it("packs the bitmask CDP expects", () => {
    expect(modifiersOf({})).toBe(0);
    expect(modifiersOf({ altKey: true })).toBe(1);
    expect(modifiersOf({ ctrlKey: true })).toBe(2);
    expect(modifiersOf({ metaKey: true })).toBe(4);
    expect(modifiersOf({ shiftKey: true })).toBe(8);
    expect(modifiersOf({ ctrlKey: true, shiftKey: true })).toBe(10);
  });
});

describe("releases and drags", () => {
  const frame = { deviceWidth: 1024, deviceHeight: 768, scale: 1 };

  it("clamps a release that drifted onto a bar instead of dropping it", () => {
    // Dropping a `mouse_up` leaves the page holding the button down forever,
    // stuck mid-selection with no way for the person to let go.
    const point = toPageCoordinates(
      { clientX: 512, clientY: 950 },
      image(1024, 968),
      frame,
      { clampToPage: true },
    );
    expect(point).toEqual({ x: 512, y: 768 });
  });

  it("still drops a PRESS on a bar", () => {
    expect(
      toPageCoordinates({ clientX: 512, clientY: 950 }, image(1024, 968), frame),
    ).toBeNull();
  });
});

describe("bounding pointer traffic", () => {
  it("collapses a run of moves and keeps everything else in order", () => {
    expect(
      coalesceInput([
        { type: "mouse_move", x: 1, y: 1 },
        { type: "mouse_move", x: 2, y: 2 },
        { type: "mouse_move", x: 3, y: 3 },
        { type: "mouse_down", x: 3, y: 3, button: "left" },
        { type: "mouse_move", x: 4, y: 4 },
      ]),
    ).toEqual([
      // The position they stopped at, not the ones nobody saw.
      { type: "mouse_move", x: 3, y: 3 },
      { type: "mouse_down", x: 3, y: 3, button: "left" },
      { type: "mouse_move", x: 4, y: 4 },
    ]);
  });

  it("keeps ONE request in flight and sends the rest behind it", async () => {
    const batches: LocalBrowserInputEvent[][] = [];
    let release!: () => void;
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sends = 0;
    const forwarder = createInputForwarder(async (events) => {
      batches.push([...events]);
      sends += 1;
      if (sends === 1) await first;
    });

    forwarder.push([{ type: "mouse_move", x: 1, y: 1 }]);
    // Everything below arrives while the first request is still open.
    forwarder.push([{ type: "mouse_move", x: 2, y: 2 }]);
    forwarder.push([{ type: "mouse_move", x: 3, y: 3 }]);
    forwarder.push([{ type: "mouse_up", x: 3, y: 3, button: "left" }]);
    expect(batches).toHaveLength(1);

    release();
    await new Promise((r) => setTimeout(r, 0));

    // Two requests, not four — and the queued moves collapsed to the last one,
    // with the release still behind it and in order.
    expect(batches).toEqual([
      [{ type: "mouse_move", x: 1, y: 1 }],
      [
        { type: "mouse_move", x: 3, y: 3 },
        { type: "mouse_up", x: 3, y: 3, button: "left" },
      ],
    ]);
  });

  it("keeps going after a refused batch", async () => {
    const batches: unknown[][] = [];
    const forwarder = createInputForwarder(async (events) => {
      batches.push([...events]);
      throw new Error("423");
    });
    forwarder.push([{ type: "mouse_move", x: 1, y: 1 }]);
    await new Promise((r) => setTimeout(r, 0));
    forwarder.push([{ type: "mouse_move", x: 2, y: 2 }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(batches).toHaveLength(2);
  });
});

describe("where the consent token may be sent", () => {
  it("accepts loopback over http and anything over https", () => {
    expect(
      isSecureLocalOrigin({ protocol: "http:", hostname: "localhost" }),
    ).toBe(true);
    expect(
      isSecureLocalOrigin({ protocol: "http:", hostname: "127.0.0.1" }),
    ).toBe(true);
    expect(
      isSecureLocalOrigin({ protocol: "https:", hostname: "inspector.example" }),
    ).toBe(true);
  });

  it("refuses a plaintext hop to another machine", () => {
    // The routes only exist on a local inspector, but the PAGE can be served
    // from anywhere — and then the consent token and every keystroke this pane
    // forwards cross a hop anyone on the path can read.
    expect(
      isSecureLocalOrigin({ protocol: "http:", hostname: "192.168.1.20" }),
    ).toBe(false);
    expect(
      isSecureLocalOrigin({ protocol: "http:", hostname: "inspector.local" }),
    ).toBe(false);
  });
});

describe("input the browser must not receive", () => {
  it("drops what is queued when the hold ends", async () => {
    // The queue is a way to send input under a permission that has since
    // gone: delivering its tail types into whoever holds the browser next.
    const batches: unknown[][] = [];
    let release!: () => void;
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sends = 0;
    const forwarder = createInputForwarder(async (events) => {
      batches.push([...events]);
      sends += 1;
      if (sends === 1) await first;
    });

    forwarder.push([{ type: "text", text: "a" }]);
    forwarder.push([{ type: "text", text: "b" }]);
    forwarder.cancel();
    release();
    await new Promise((r) => setTimeout(r, 0));

    // The one already in flight went; the queued "b" did not.
    expect(batches).toEqual([[{ type: "text", text: "a" }]]);
  });

  it("refuses anything pushed after cancel", async () => {
    const batches: unknown[][] = [];
    const forwarder = createInputForwarder(async (events) => {
      batches.push([...events]);
    });
    forwarder.cancel();
    forwarder.push([{ type: "text", text: "a" }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(batches).toEqual([]);
  });

  it("chunks at the server's batch limit instead of losing the tail", async () => {
    // The route SLICES anything longer, so an oversized request silently drops
    // its tail — for keys and buttons, a page left holding what nobody pressed.
    const batches: LocalBrowserInputEvent[][] = [];
    let release!: () => void;
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sends = 0;
    const forwarder = createInputForwarder(async (events) => {
      batches.push([...events]);
      sends += 1;
      if (sends === 1) await first;
    });

    forwarder.push([{ type: "text", text: "first" }]);
    // 100 non-coalescible events pile up behind the open request.
    for (let i = 0; i < 100; i += 1) {
      forwarder.push([{ type: "text", text: `k${i}` }]);
    }
    release();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(batches[0]).toEqual([{ type: "text", text: "first" }]);
    expect(batches[1]).toHaveLength(INPUT_BATCH_LIMIT);
    // Nothing lost: every queued event arrives, across as many requests as
    // the limit needs.
    expect(batches.flat()).toHaveLength(101);
  });
});
