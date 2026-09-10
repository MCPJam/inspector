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

/**
 * A scheduler a test can step.
 *
 * The forwarder batches on an animation frame, and "one frame later" is
 * exactly the behaviour under test — a fake timer would measure the timer.
 */
function stepper() {
  let pending: Array<() => void> = [];
  return {
    schedule: (fn: () => void) => {
      pending.push(fn);
    },
    /** One animation frame. */
    frame() {
      const due = pending;
      pending = [];
      for (const fn of due) fn();
    },
    pendingCount: () => pending.length,
  };
}

describe("batching a gesture", () => {
  it("holds a run of moves for one frame and sends the last of them", () => {
    const batches: BrowserInputEvent[][] = [];
    const clock = stepper();
    const forwarder = createInputForwarder(
      (events) => {
        batches.push([...events]);
      },
      { schedule: clock.schedule },
    );

    forwarder.push([{ type: "mouse_move", x: 1, y: 1 }]);
    forwarder.push([{ type: "mouse_move", x: 2, y: 2 }]);
    forwarder.push([{ type: "mouse_move", x: 3, y: 3 }]);
    // Nothing yet: a move is one of a stream and nobody notices which frame
    // it went in.
    expect(batches).toEqual([]);

    clock.frame();
    expect(batches).toEqual([[{ type: "mouse_move", x: 3, y: 3 }]]);
  });

  it("flushes a press, a release, a key and text at once", () => {
    // The transitions a person can FEEL. A click that waits for the next
    // animation frame is a click that feels late, which is the whole subject
    // of this wave.
    const urgent: BrowserInputEvent[] = [
      { type: "mouse_down", x: 1, y: 1, button: "left" },
      { type: "mouse_up", x: 1, y: 1, button: "left" },
      { type: "key_down", key: "Enter" },
      { type: "key_up", key: "Enter" },
      { type: "text", text: "a" },
    ];
    for (const event of urgent) {
      const batches: BrowserInputEvent[][] = [];
      const clock = stepper();
      const forwarder = createInputForwarder(
        (events) => {
          batches.push([...events]);
        },
        { schedule: clock.schedule },
      );
      forwarder.push([event]);
      expect(batches).toEqual([[event]]);
    }
  });

  it("carries the move that preceded a press in the same flush", () => {
    // A press is dispatched at a point, and the page tracks the pointer to get
    // there: splitting them across frames is how a click lands on the element
    // the pointer was over one frame ago.
    const batches: BrowserInputEvent[][] = [];
    const clock = stepper();
    const forwarder = createInputForwarder(
      (events) => {
        batches.push([...events]);
      },
      { schedule: clock.schedule },
    );
    forwarder.push([{ type: "mouse_move", x: 9, y: 9 }]);
    forwarder.push([{ type: "mouse_down", x: 9, y: 9, button: "left" }]);
    expect(batches).toEqual([
      [
        { type: "mouse_move", x: 9, y: 9 },
        { type: "mouse_down", x: 9, y: 9, button: "left" },
      ],
    ]);
  });

  it("does NOT wait for the last send when the transport is ordered", () => {
    // The socket is ordered, so the round trip the old queue spent buying
    // ordering is pure latency. Reverting this — serializing on the socket —
    // puts a full RTT back into every gesture after the first.
    const batches: BrowserInputEvent[][] = [];
    const clock = stepper();
    const forwarder = createInputForwarder(
      (events) => {
        batches.push([...events]);
        // Never resolves: an unanswered send must not stop the next one.
        return new Promise<void>(() => {});
      },
      { schedule: clock.schedule },
    );
    forwarder.push([{ type: "text", text: "a" }]);
    forwarder.push([{ type: "text", text: "b" }]);
    expect(batches).toEqual([
      [{ type: "text", text: "a" }],
      [{ type: "text", text: "b" }],
    ]);
  });

  it("stamps each batch with a seq the ack can name", () => {
    const seqs: number[] = [];
    const clock = stepper();
    const forwarder = createInputForwarder(
      (_events, seq) => {
        seqs.push(seq);
      },
      { schedule: clock.schedule },
    );
    forwarder.push([{ type: "text", text: "a" }]);
    forwarder.push([{ type: "text", text: "b" }]);
    expect(seqs).toEqual([1, 2]);
  });
});

describe("bounding pointer traffic on the POST fallback", () => {
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
    // Concurrent POSTs arrive in whatever order the network felt like, and an
    // out-of-order drag lands where nobody aimed. The socket does not need
    // this; HTTP does.
    const batches: BrowserInputEvent[][] = [];
    let release!: () => void;
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sends = 0;
    const clock = stepper();
    const forwarder = createInputForwarder(
      async (events) => {
        batches.push([...events]);
        sends += 1;
        if (sends === 1) await first;
      },
      { schedule: clock.schedule, serialize: () => true },
    );

    forwarder.push([{ type: "mouse_move", x: 1, y: 1 }]);
    clock.frame();
    // Everything below arrives while the first request is still open.
    forwarder.push([{ type: "mouse_move", x: 2, y: 2 }]);
    forwarder.push([{ type: "mouse_move", x: 3, y: 3 }]);
    forwarder.push([{ type: "mouse_up", x: 3, y: 3, button: "left" }]);
    expect(batches).toHaveLength(1);

    release();
    await new Promise((r) => setTimeout(r, 0));
    clock.frame();

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
    const forwarder = createInputForwarder(
      async (events) => {
        batches.push([...events]);
        throw new Error("423");
      },
      { schedule: (fn) => fn(), serialize: () => true },
    );
    forwarder.push([{ type: "mouse_move", x: 1, y: 1 }]);
    await new Promise((r) => setTimeout(r, 0));
    forwarder.push([{ type: "mouse_move", x: 2, y: 2 }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(batches).toHaveLength(2);
  });
});

describe("a transport that changes mid-gesture", () => {
  it("keeps waiting on a POST even after the socket comes back", async () => {
    // The serialize predicate is read per batch, so a `hello` (or a reconnect)
    // arriving while a POST is still travelling used to let the very next
    // batch go straight down the socket — where it can reach the daemon FIRST.
    // An unordered press/release leaves the page holding a button.
    const batches: unknown[][] = [];
    let release!: () => void;
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    let onSocket = false;
    let sends = 0;
    const forwarder = createInputForwarder(
      async (events) => {
        batches.push([...events]);
        sends += 1;
        if (sends === 1) await first;
      },
      { schedule: (fn) => fn(), serialize: () => !onSocket },
    );

    forwarder.push([{ type: "mouse_down", x: 1, y: 1, button: "left" }]);
    expect(batches).toHaveLength(1);

    // The socket announces itself while the POST is still open.
    onSocket = true;
    forwarder.push([{ type: "mouse_up", x: 1, y: 1, button: "left" }]);
    expect(batches).toHaveLength(1);

    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(batches).toHaveLength(2);
    expect(batches[1]).toEqual([
      { type: "mouse_up", x: 1, y: 1, button: "left" },
    ]);
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
    const clock = stepper();
    const forwarder = createInputForwarder(
      async (events) => {
        batches.push([...events]);
        sends += 1;
        if (sends === 1) await first;
      },
      { schedule: clock.schedule, serialize: () => true },
    );

    forwarder.push([{ type: "text", text: "a" }]);
    forwarder.push([{ type: "text", text: "b" }]);
    forwarder.cancel();
    release();
    await new Promise((r) => setTimeout(r, 0));
    clock.frame();

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
    const clock = stepper();
    const forwarder = createInputForwarder(
      async (events) => {
        batches.push([...events]);
        sends += 1;
        if (sends === 1) await first;
      },
      { schedule: clock.schedule, serialize: () => true },
    );

    forwarder.push([{ type: "text", text: "first" }]);
    // 100 non-coalescible events pile up behind the open request.
    for (let i = 0; i < 100; i += 1) {
      forwarder.push([{ type: "text", text: `k${i}` }]);
    }
    release();
    await new Promise((r) => setTimeout(r, 0));
    clock.frame();
    await new Promise((r) => setTimeout(r, 0));
    clock.frame();
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
  it("SUMS adjacent wheels instead of replaying them one at a time", () => {
    // Each wheel is a DELTA, so it cannot be dropped like a superseded move —
    // but queueing them individually means the page goes on scrolling long
    // after the person stopped, by however long the queue was. Summed, the
    // distance is exact and arrives as one movement.
    const batches: unknown[][] = [];
    const clock = stepper();
    const forwarder = createInputForwarder(
      (events) => {
        batches.push([...events]);
      },
      { schedule: clock.schedule },
    );

    for (let i = 0; i < 6; i += 1) {
      forwarder.push([{ type: "wheel", x: 5, y: 5, deltaX: 0, deltaY: 10 }]);
    }
    // A wheel is not a transition a person feels as a discrete act, so the
    // whole gesture rides one frame.
    expect(batches).toEqual([]);
    clock.frame();
    expect(batches).toEqual([
      [{ type: "wheel", x: 5, y: 5, deltaX: 0, deltaY: 60 }],
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

describe("shared gesture ordering", () => {
  it("pipelines ordered sends, bounds the window, and drains after an ack", async () => {
    const batches: BrowserInputEvent[][] = [];
    const acks: Array<() => void> = [];
    const forwarder = createInputForwarder((events) => {
      batches.push(events);
      return new Promise<void>((resolve) => acks.push(resolve));
    });
    for (let i = 0; i < 20; i++)
      forwarder.push([{ type: "text", text: String(i) }]);
    expect(batches).toHaveLength(16);
    acks[0]();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(batches).toHaveLength(17);
    expect(batches[16]).toEqual(
      [16, 17, 18, 19].map((i) => ({ type: "text", text: String(i) })),
    );
    forwarder.cancel();
    acks.forEach((ack) => ack());
  });

  it("merges trackpad jitter and preserves a reversal on the dominant axis", () => {
    const wheel = (deltaX: number, deltaY: number): BrowserInputEvent => ({
      type: "wheel",
      x: 10,
      y: 20,
      deltaX,
      deltaY,
    });
    expect(
      coalesceInput([wheel(0.2, 10), wheel(-0.1, 15), wheel(0.1, -12)]),
    ).toEqual([wheel(0.1, 25), wheel(0.1, -12)]);
  });
});

it("chunks long pasted text without splitting an emoji", () => {
  const text = "a".repeat(4095) + "🍕" + "z".repeat(4200);
  const sent: BrowserInputEvent[] = [];
  const forwarder = createInputForwarder((events) => {
    sent.push(...events);
  });
  forwarder.push([{ type: "text", text }]);
  const chunks = sent
    .filter((event) => event.type === "text")
    .map((event) => event.text);
  expect(chunks.join("")).toBe(text);
  expect(
    chunks.every(
      (chunk) => chunk.length <= 4096 && !/[\uD800-\uDBFF]$/.test(chunk),
    ),
  ).toBe(true);
  expect(chunks[1].startsWith("🍕")).toBe(true);
});
