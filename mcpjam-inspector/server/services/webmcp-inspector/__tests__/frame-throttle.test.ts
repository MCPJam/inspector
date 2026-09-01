/**
 * The throttle's one job that a plain rate limiter gets wrong: never losing the
 * LAST frame of a burst. Everything here is driven by an injected clock and
 * injected timers, so nothing waits on real time.
 */
import { describe, expect, it } from "vitest";
import { createFrameThrottle } from "../frame-throttle";

/** A hand-cranked clock plus a one-slot timer queue, as the module uses them. */
function harness(minIntervalMs = 100) {
  let clock = 1_000;
  const emitted: string[] = [];
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextHandle = 1;
  /** How many times a timer was ARMED, which is the claim under test below. */
  let armings = 0;

  const throttle = createFrameThrottle<string>({
    minIntervalMs,
    emit: (value) => emitted.push(value),
    now: () => clock,
    setTimer: (fn, ms) => {
      armings += 1;
      const handle = nextHandle++;
      timers.set(handle, { at: clock + ms, fn });
      return handle;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
  });

  return {
    throttle,
    emitted,
    pendingTimers: () => timers.size,
    armings: () => armings,
    /**
     * Move the clock WITHOUT running due timers — a timer callback that has not
     * been reached yet. Node makes no promise about firing on the millisecond,
     * and under load it routinely runs late.
     */
    jump(ms: number) {
      clock += ms;
    },
    /** Advance the clock and fire whatever came due, oldest first. */
    advance(ms: number) {
      clock += ms;
      for (const [handle, timer] of [...timers].sort(
        (a, b) => a[1].at - b[1].at,
      )) {
        if (timer.at > clock) continue;
        timers.delete(handle);
        timer.fn();
      }
    },
  };
}

describe("createFrameThrottle", () => {
  it("emits the first frame immediately", () => {
    const h = harness();
    h.throttle.push("a");
    expect(h.emitted).toEqual(["a"]);
  });

  it("coalesces a burst down to the leading frame and the LAST one", () => {
    const h = harness(100);
    h.throttle.push("a");
    h.advance(10);
    h.throttle.push("b");
    h.advance(10);
    h.throttle.push("c");
    h.advance(10);
    h.throttle.push("final");

    // Still only the leading frame: the rest are inside the window.
    expect(h.emitted).toEqual(["a"]);

    h.advance(100);
    // The trailing frame is the guarantee that matters. Without it the pane
    // would sit on "a" until the page happened to paint again — which for a
    // page that has finished animating is never.
    expect(h.emitted).toEqual(["a", "final"]);
  });

  it("arms the trailing timer once per window, not once per frame", () => {
    const h = harness(100);
    h.throttle.push("a");
    // Twenty pushes, all inside ONE window (20ms of a 100ms floor). Re-arming
    // on each would postpone the flush for as long as the stream kept going.
    for (let i = 0; i < 20; i++) {
      h.advance(1);
      h.throttle.push(`f${i}`);
    }
    // The COUNT of arms, not just the count outstanding. A per-frame re-arming
    // implementation happens to land on the same absolute deadline here
    // (`minIntervalMs - elapsed` from a fixed `lastEmitAt`), so it would leave
    // one pending timer and the same output — and pass a test that only looked
    // at those. Twenty pushes inside one window must arm exactly once.
    expect(h.armings()).toBe(1);
    expect(h.pendingTimers()).toBe(1);
    expect(h.emitted).toEqual(["a"]);

    h.advance(100);
    expect(h.emitted).toEqual(["a", "f19"]);
  });

  it("emits immediately again once the window has passed", () => {
    const h = harness(100);
    h.throttle.push("a");
    h.advance(150);
    h.throttle.push("b");
    expect(h.emitted).toEqual(["a", "b"]);
    expect(h.pendingTimers()).toBe(0);
  });

  it("supersedes a held frame when its timer runs late", () => {
    const h = harness(100);
    h.throttle.push("a");
    h.advance(10);
    h.throttle.push("stale");
    // The window has closed but the trailing timer has not been reached yet —
    // an ordinary late timer under load. The next push is a leading edge, and
    // the frame it holds is newer, so the stale one must be dropped rather
    // than emitted afterwards and painting the page backwards.
    h.jump(200);
    h.throttle.push("fresh");
    expect(h.emitted).toEqual(["a", "fresh"]);
    expect(h.pendingTimers()).toBe(0);
    // The cancelled timer must not resurrect the stale frame later.
    h.advance(500);
    expect(h.emitted).toEqual(["a", "fresh"]);
  });

  it("drops the held frame and clears its timer on reset", () => {
    const h = harness(100);
    h.throttle.push("a");
    h.advance(10);
    h.throttle.push("held");
    h.throttle.reset();
    h.advance(500);
    // Nothing arrives after a reset: the stream was stopped, and repainting a
    // pane that has just been told there is nothing to watch is worse than
    // leaving it alone.
    expect(h.emitted).toEqual(["a"]);
    expect(h.pendingTimers()).toBe(0);
  });

  it("treats the first frame after a reset as a leading edge", () => {
    const h = harness(100);
    h.throttle.push("a");
    h.throttle.reset();
    h.throttle.push("b");
    // No clock advance: without clearing the last-emit time, restarting the
    // stream would hold its first frame for a full window.
    expect(h.emitted).toEqual(["a", "b"]);
  });
});
