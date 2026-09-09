import { describe, expect, it } from "vitest";
import { SessionBarrier } from "../session-barrier";
import type { ViewportSize } from "../../../../../shared/browser-viewport";

/**
 * A hand-driven clock and timer set.
 *
 * Real timers would make every assertion in this file a race against a 150ms
 * debounce, and the thing under test is precisely WHEN a resize is allowed to
 * run — so the test has to own the moment.
 */
function harness(options: { maxWaitMs?: number } = {}) {
  const applied: ViewportSize[] = [];
  let releaseApply: (() => void) | null = null;
  let now = 1_000;
  const timers = new Map<number, { fn: () => void; at: number }>();
  let nextHandle = 1;

  const barrier = new SessionBarrier(
    async (size) => {
      applied.push(size);
      if (releaseApply) {
        // A transition the test holds open, so "work waits for a resize" is
        // observable rather than instantaneous.
        await new Promise<void>((resolve) => {
          const previous = releaseApply!;
          releaseApply = () => {
            previous();
            resolve();
          };
        });
      }
    },
    {
      debounceMs: 100,
      ...(options.maxWaitMs !== undefined ? { maxWaitMs: options.maxWaitMs } : {}),
      now: () => now,
      setTimer: (fn, ms) => {
        const handle = nextHandle++;
        timers.set(handle, { fn, at: now + ms });
        return handle;
      },
      clearTimer: (handle) => {
        timers.delete(handle as number);
      },
    },
  );

  const advance = (ms: number) => {
    now += ms;
    for (const [handle, timer] of [...timers]) {
      if (timer.at <= now) {
        timers.delete(handle);
        timer.fn();
      }
    }
  };

  return {
    barrier,
    applied,
    advance,
    holdApply() {
      releaseApply = () => {};
    },
    releaseApply() {
      const release = releaseApply;
      releaseApply = null;
      release?.();
    },
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("SessionBarrier", () => {
  it("coalesces a drag into one resize at the final size", async () => {
    // Sixty measurements a second, each a full display + kiosk + viewport +
    // encoder transition. Only the last size was ever wanted.
    const h = harness();
    for (let width = 1000; width <= 1400; width += 100) {
      void h.barrier.request({ width, height: 800 });
      h.advance(16);
    }
    h.advance(100);
    await flush();
    expect(h.applied).toEqual([{ width: 1400, height: 800 }]);
  });

  it("settles every coalesced request once the resize lands", async () => {
    const h = harness();
    const first = h.barrier.request({ width: 1000, height: 800 });
    const last = h.barrier.request({ width: 1400, height: 800 });
    h.advance(100);
    await flush();
    await expect(Promise.all([first, last])).resolves.toBeDefined();
  });

  it("does not resize while work is in flight", async () => {
    const h = harness();
    let finishWork: (() => void) | null = null;
    const work = h.barrier.run(
      () => new Promise<void>((resolve) => (finishWork = resolve)),
    );
    await flush();

    void h.barrier.request({ width: 1400, height: 900 });
    h.advance(100);
    await flush();
    // The reflow would land under a selector the driver has already resolved.
    expect(h.applied).toEqual([]);

    finishWork!();
    await work;
    await flush();
    expect(h.applied).toEqual([{ width: 1400, height: 900 }]);
  });

  it("does not resize mid-drag, and runs the moment the pointer comes up", async () => {
    const h = harness();
    h.barrier.beginDrag();
    void h.barrier.request({ width: 1400, height: 900 });
    h.advance(100);
    await flush();
    expect(h.applied).toEqual([]);

    h.barrier.endDrag();
    await flush();
    expect(h.applied).toEqual([{ width: 1400, height: 900 }]);
  });

  it("holds work off while a resize is transitioning", async () => {
    const h = harness();
    h.holdApply();
    void h.barrier.request({ width: 1400, height: 900 });
    h.advance(100);
    await flush();
    expect(h.applied).toHaveLength(1);

    let ran = false;
    const work = h.barrier.run(async () => {
      ran = true;
    });
    await flush();
    // An act that started between geometries would resolve a box in one and
    // click in the other.
    expect(ran).toBe(false);

    h.releaseApply();
    await work;
    expect(ran).toBe(true);
  });

  it("gives up waiting for work that blew its own budget", async () => {
    // A browser stuck at the wrong size behind one hung command, whose own
    // timeout is minutes, is worse than a resize the command did not expect.
    const h = harness({ maxWaitMs: 500 });
    void h.barrier.run(() => new Promise<void>(() => {}));
    await flush();

    void h.barrier.request({ width: 1400, height: 900 });
    h.advance(100);
    await flush();
    expect(h.applied).toEqual([]);

    // Past the ceiling, and something has to poke it — the next measurement.
    h.advance(500);
    void h.barrier.request({ width: 1400, height: 900 });
    h.advance(100);
    await flush();
    expect(h.applied).toEqual([{ width: 1400, height: 900 }]);
  });

  it("applies a measurement that arrived during a transition", async () => {
    const h = harness();
    h.holdApply();
    void h.barrier.request({ width: 1200, height: 800 });
    h.advance(100);
    await flush();
    expect(h.applied).toEqual([{ width: 1200, height: 800 }]);

    void h.barrier.request({ width: 1600, height: 1000 });
    h.advance(100);
    await flush();
    h.releaseApply();
    await flush();
    await flush();
    // A burst spanning a transition converges rather than stopping one short.
    expect(h.applied).toEqual([
      { width: 1200, height: 800 },
      { width: 1600, height: 1000 },
    ]);
  });

  it("does not latch shut when a resize fails", async () => {
    const applied: ViewportSize[] = [];
    let failNext = true;
    const barrier = new SessionBarrier(
      async (size) => {
        applied.push(size);
        if (failNext) {
          failNext = false;
          throw new Error("the display refused");
        }
      },
      { debounceMs: 0 },
    );
    await barrier.request({ width: 1200, height: 800 });
    // The next one still runs, and so does ordinary work.
    await barrier.request({ width: 1300, height: 800 });
    await expect(barrier.run(async () => "ok")).resolves.toBe("ok");
    expect(applied).toHaveLength(2);
  });

  it("does not wedge when work throws", async () => {
    const h = harness();
    await expect(
      h.barrier.run(async () => {
        throw new Error("the click missed");
      }),
    ).rejects.toThrow("the click missed");

    void h.barrier.request({ width: 1400, height: 900 });
    h.advance(100);
    await flush();
    expect(h.applied).toEqual([{ width: 1400, height: 900 }]);
  });

  it("reports busy from the first measurement until the resize lands", async () => {
    const h = harness();
    expect(h.barrier.busy).toBe(false);
    h.holdApply();
    void h.barrier.request({ width: 1400, height: 900 });
    expect(h.barrier.busy).toBe(true);
    h.advance(100);
    await flush();
    expect(h.barrier.busy).toBe(true);
    h.releaseApply();
    await flush();
    await flush();
    expect(h.barrier.busy).toBe(false);
  });
});
