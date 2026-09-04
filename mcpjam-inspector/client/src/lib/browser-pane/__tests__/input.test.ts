/**
 * The pane's pointer arithmetic, shared by every engine.
 *
 * These moved here with the code when the hosted pane started using it. They
 * are the same assertions: a click on an `object-contain` letterbox bar is not
 * a click on the page, a release that drifted onto one still has to land, and
 * a queue outliving its hold types into whoever holds the browser next.
 */
import { describe, expect, it } from "vitest";
import {
  coalesceInput,
  createInputForwarder,
  INPUT_BATCH_LIMIT,
  modifiersOf,
  toPageCoordinates,
  type BrowserInputEvent,
} from "../input";

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
      toPageCoordinates(
        { clientX: 512, clientY: 384 },
        image(1024, 768),
        frame,
      ),
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
      toPageCoordinates(
        { clientX: 512, clientY: 950 },
        image(1024, 968),
        frame,
      ),
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
    const batches: BrowserInputEvent[][] = [];
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
    const batches: BrowserInputEvent[][] = [];
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
    // The LITERAL, not the imported constant. The route slices at 64 of its
    // own (`server/routes/mcp/computers.ts`, pinned by the matching literal in
    // `computers-local-browser.test.ts`), and the client cannot import from
    // `server/**` to share one. Asserting the constant against itself passes
    // however far the two drift — and the cost of drift is silence: an
    // oversized batch loses its tail, so a key or a button is left held on a
    // page nobody pressed it on.
    expect(INPUT_BATCH_LIMIT).toBe(64);
    expect(batches[1]).toHaveLength(64);
    // Nothing lost: every queued event arrives, across as many requests as
    // the limit needs.
    expect(batches.flat()).toHaveLength(101);
  });
});

describe("a scroll that outlived the gesture", () => {
  it("SUMS adjacent wheels instead of replaying them one at a time", async () => {
    // Each wheel is a DELTA, so it cannot be dropped like a superseded move —
    // but queueing them individually means the page goes on scrolling long
    // after the person stopped, by however long the queue was. Summed, the
    // distance is exact and arrives as one movement.
    const batches: unknown[][] = [];
    let release: (() => void) | null = null;
    const forwarder = createInputForwarder(async (events) => {
      batches.push(events);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });

    forwarder.push([{ type: "wheel", x: 5, y: 5, deltaX: 0, deltaY: 10 }]);
    // The first is in flight; the rest of the gesture piles up behind it.
    for (let i = 0; i < 5; i += 1) {
      forwarder.push([{ type: "wheel", x: 5, y: 5, deltaX: 0, deltaY: 10 }]);
    }
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(batches).toHaveLength(2);
    expect(batches[1]).toEqual([
      { type: "wheel", x: 5, y: 5, deltaX: 0, deltaY: 50 },
    ]);
  });

  it("keeps a zoom apart from a scroll, and a move in between", () => {
    // Ctrl+wheel is a zoom. Merging it into a scroll would zoom by the
    // scroll's distance, and merging across a press would move the page under
    // a click that had already landed.
    const batches: unknown[][] = [];
    const forwarder = createInputForwarder(async (events) => {
      batches.push(events);
    });
    forwarder.push([
      { type: "wheel", x: 5, y: 5, deltaX: 0, deltaY: 10 },
      { type: "wheel", x: 5, y: 5, deltaX: 0, deltaY: 10, modifiers: 2 },
      { type: "mouse_down", x: 5, y: 5, button: "left" },
      { type: "wheel", x: 5, y: 5, deltaX: 0, deltaY: 10 },
    ]);
    expect(batches[0]).toHaveLength(4);
  });
});
