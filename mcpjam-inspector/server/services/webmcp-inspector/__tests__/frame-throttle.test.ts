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

  it("raises the floor while boosted, and restores it when the boost expires", () => {
    const h = harness(100);
    h.throttle.boost(33, 1_500);

    h.throttle.push("a");
    h.advance(40);
    h.throttle.push("b");
    h.advance(40);
    h.throttle.push("c");
    // 40ms apart clears a 33ms floor but not a 100ms one: at the resting rate
    // only "a" would have gone out, and the person driving the page would be
    // watching their own scroll at 10fps.
    expect(h.emitted).toEqual(["a", "b", "c"]);

    // Past the window, arithmetically — no decay timer, nothing to leak.
    h.advance(1_500);
    h.throttle.push("d");
    h.advance(40);
    h.throttle.push("e");
    expect(h.emitted).toEqual(["a", "b", "c", "d"]);
    h.advance(100);
    expect(h.emitted).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("extends the window on a repeat boost rather than stacking", () => {
    const h = harness(100);
    h.throttle.boost(33, 1_000);
    h.throttle.push("a");
    // A continuous gesture: each batch of input re-boosts, and the rate has to
    // hold for as long as it lasts.
    for (const label of ["b", "c", "d"]) {
      h.advance(900);
      h.throttle.boost(33, 1_000);
      h.throttle.push(label);
    }
    expect(h.emitted).toEqual(["a", "b", "c", "d"]);
  });

  it("re-arms a pending trailing timer with the shorter delay", () => {
    const h = harness(100);
    h.throttle.push("a");
    h.advance(5);
    // Held behind the 100ms floor, with the timer already armed for ~95ms.
    h.throttle.push("echo");
    expect(h.emitted).toEqual(["a"]);

    // THE input arrives. Without a re-arm, the frame that echoes it waits out
    // the old window — so the first and most noticeable paint of a gesture is
    // exactly the one the boost fails to speed up.
    h.throttle.boost(33, 1_500);
    h.advance(28);
    expect(h.emitted).toEqual(["a", "echo"]);
  });

  it("flushes at once when the boost makes a held frame already due", () => {
    const h = harness(100);
    h.throttle.push("a");
    h.advance(50);
    h.throttle.push("echo");
    // 50ms have passed, which is already past a 33ms floor. Re-arming for a
    // negative delay is a timer that may never fire on some runtimes; the
    // frame is due now, so it goes now.
    h.throttle.boost(33, 1_500);
    expect(h.emitted).toEqual(["a", "echo"]);
    expect(h.pendingTimers()).toBe(0);
  });

  it("does nothing to a boost with no frame held", () => {
    const h = harness(100);
    h.throttle.push("a");
    h.throttle.boost(33, 1_500);
    // Nothing was waiting, so nothing is emitted early and no timer is armed
    // for a frame that does not exist.
    expect(h.emitted).toEqual(["a"]);
    expect(h.pendingTimers()).toBe(0);
    expect(h.armings()).toBe(0);
  });

  it("re-arms a trailing frame whose timer crossed the boost expiry", () => {
    const h = harness(100);
    h.throttle.boost(33, 40);
    h.throttle.push("a");
    h.advance(5);
    // Held with a ~28ms deadline, set while the boost was in force.
    h.throttle.push("held");
    expect(h.emitted).toEqual(["a"]);

    // The boost expires (at +40ms) BEFORE that timer fires. Emitting on the
    // old deadline would put this frame 33ms after the last one, under a
    // resting floor of 100ms.
    h.advance(45);
    expect(h.emitted).toEqual(["a"]);

    // …and it is not postponed forever either: the interval grows once, so
    // there is exactly one re-arm and then the frame goes.
    h.advance(60);
    expect(h.emitted).toEqual(["a", "held"]);
    expect(h.pendingTimers()).toBe(0);
  });

  it("emits a trailing frame on time when the boost is still in force", () => {
    const h = harness(100);
    h.throttle.boost(33, 5_000);
    h.throttle.push("a");
    h.advance(5);
    h.throttle.push("held");
    // The re-arm must not cost the boost its speed: with the boost still on,
    // the frame is due at 33ms and goes then.
    h.advance(30);
    expect(h.emitted).toEqual(["a", "held"]);
  });

  it("clears the boost on reset", () => {
    const h = harness(100);
    h.throttle.boost(33, 10_000);
    h.throttle.push("a");
    // The stream stopped, so whoever was driving it is not driving it any
    // more — a boost surviving that would keep a restarted stream at 30fps
    // for whatever was left of a ten-second window nobody asked to extend.
    h.throttle.reset();
    h.throttle.push("b");
    h.advance(40);
    h.throttle.push("c");
    expect(h.emitted).toEqual(["a", "b"]);
    h.advance(100);
    expect(h.emitted).toEqual(["a", "b", "c"]);
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
