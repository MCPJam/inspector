import { afterEach, describe, expect, it, vi } from "vitest";

import {
  deadlineClockOf,
  runWithDeadline,
  withDeadline,
  type DeadlineAbortError,
} from "../deadline.js";

afterEach(() => {
  vi.useRealTimers();
});

/** A clock that only moves when a test says so — no fake timers needed. */
function fakeClock(start = 1_000): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe("withDeadline — the abort reason", () => {
  it("raises an AbortError that names its clock", async () => {
    vi.useFakeTimers();
    const handle = withDeadline(undefined, 1_000, "iteration");
    expect(handle.signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(handle.signal.aborted).toBe(true);
    const reason = handle.signal.reason as DeadlineAbortError;
    // The name is load-bearing: `evals-runner.ts` widens its abort branch on
    // `error.name === "AbortError"` and would otherwise take the full failure
    // path — widget capture, an SSE failure event, a `failed` write — for what
    // is an infrastructure event, not a verdict.
    expect(reason.name).toBe("AbortError");
    expect(reason.clock).toBe("iteration");
    expect(reason.budgetMs).toBe(1_000);
    handle.dispose();
  });

  it("reads the clock back off a reason, a cause chain, or neither", () => {
    vi.useFakeTimers();
    const handle = withDeadline(undefined, 1, "turn");
    vi.advanceTimersByTime(1);
    const reason = handle.signal.reason;

    expect(deadlineClockOf(reason)).toBe("turn");
    expect(deadlineClockOf(new Error("wrapped", { cause: reason }))).toBe(
      "turn",
    );
    expect(deadlineClockOf(new Error("plain"))).toBeUndefined();
    expect(deadlineClockOf(undefined)).toBeUndefined();
    // Free text is not a clock: the union is closed, and a caller must not be
    // able to invent `metadata.timeout.clock` values by throwing an object.
    expect(
      deadlineClockOf({ name: "AbortError", clock: "wall" }),
    ).toBeUndefined();
    // Nor is a `clock` property on something that is not an abort at all. Both
    // marks are required on the SAME object, or an unrelated failure that
    // happens to carry the word would be persisted with a timeout clock.
    expect(deadlineClockOf({ clock: "turn" })).toBeUndefined();
    expect(
      deadlineClockOf(Object.assign(new Error("boom"), { clock: "turn" })),
    ).toBeUndefined();
    handle.dispose();
  });

  it("survives a cyclic cause chain", () => {
    const a: { cause?: unknown } = {};
    a.cause = a;
    expect(deadlineClockOf(a)).toBeUndefined();
  });
});

describe("withDeadline — which clock fired", () => {
  it("reports its OWN clock, never an inherited one", async () => {
    vi.useFakeTimers();
    const run = withDeadline(undefined, 1_000, "run");
    const unit = withDeadline(run.signal, 10_000, "iteration");

    await vi.advanceTimersByTimeAsync(1_000);

    expect(unit.signal.aborted).toBe(true);
    // This is the distinction the swarm's terminal write turns on: "my unit ran
    // out" (`session_timeout`) vs "the whole run was cancelled" (`run_timeout`).
    // Inheriting the parent's clock would erase it.
    expect(unit.firedClock()).toBeUndefined();
    expect(run.firedClock()).toBe("run");
    // ...and the reason still carries the parent's clock, for a caller that
    // wants to name what actually happened.
    expect(deadlineClockOf(unit.signal.reason)).toBe("run");
    unit.dispose();
    run.dispose();
  });

  it("fires the child when the child's budget is the shorter one", async () => {
    vi.useFakeTimers();
    const run = withDeadline(undefined, 10_000, "run");
    const unit = withDeadline(run.signal, 1_000, "iteration");

    await vi.advanceTimersByTimeAsync(1_000);

    expect(unit.firedClock()).toBe("iteration");
    expect(run.firedClock()).toBeUndefined();
    expect(run.signal.aborted).toBe(false);
    unit.dispose();
    run.dispose();
  });

  it("aborts synchronously when handed no budget", () => {
    const handle = withDeadline(undefined, 0, "toolCall");
    // `remainingMs()` reading 0 BEFORE the first await is what lets a caller
    // skip work it could only throw away.
    expect(handle.signal.aborted).toBe(true);
    expect(handle.firedClock()).toBe("toolCall");
    expect(handle.remainingMs()).toBe(0);
    handle.dispose();
  });

  it("inherits an already-aborted parent", () => {
    const parent = new AbortController();
    parent.abort(new Error("cancelled by user"));
    const handle = withDeadline(parent.signal, 60_000, "session");
    expect(handle.signal.aborted).toBe(true);
    expect(handle.firedClock()).toBeUndefined();
    handle.dispose();
  });
});

describe("withDeadline — accounting", () => {
  it("tracks elapsed and remaining against an injected clock", () => {
    const clock = fakeClock();
    const handle = withDeadline(undefined, 10_000, "iteration", {
      now: clock.now,
    });

    expect(handle.elapsedMs()).toBe(0);
    expect(handle.remainingMs()).toBe(10_000);

    clock.advance(4_000);
    expect(handle.elapsedMs()).toBe(4_000);
    // The number a nested capacity budget is clamped to: `min(5 min, remaining)`.
    expect(handle.remainingMs()).toBe(6_000);

    clock.advance(30_000);
    expect(handle.remainingMs()).toBe(0);
    expect(handle.elapsedMs()).toBe(34_000);
    handle.dispose();
  });

  it("arms no timer for an unbounded budget", () => {
    vi.useFakeTimers();
    // `setTimeout` truncates anything past its 32-bit range to 1ms, so arming
    // it here would fire the deadline IMMEDIATELY — the exact opposite of what
    // an unbounded budget asked for.
    const handle = withDeadline(undefined, Number.POSITIVE_INFINITY, "run");
    vi.advanceTimersByTime(60_000);
    expect(handle.signal.aborted).toBe(false);
    expect(handle.firedClock()).toBeUndefined();
    handle.dispose();
  });
});

describe("withDeadline — teardown", () => {
  it("clears its timer and drops the parent listener", () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const before = vi.getTimerCount();
    const handle = withDeadline(parent.signal, 60_000, "iteration");
    expect(vi.getTimerCount()).toBeGreaterThan(before);

    handle.dispose();
    expect(vi.getTimerCount()).toBe(before);

    vi.advanceTimersByTime(120_000);
    expect(handle.firedClock()).toBeUndefined();
  });

  it("is idempotent", () => {
    const handle = withDeadline(undefined, 60_000, "iteration");
    handle.dispose();
    expect(() => handle.dispose()).not.toThrow();
  });

  it("disposes through runWithDeadline even when the body throws", async () => {
    vi.useFakeTimers();
    const before = vi.getTimerCount();
    await expect(
      runWithDeadline(undefined, 60_000, "turn", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(vi.getTimerCount()).toBe(before);
  });

  it("hands the body its own handle so a nested budget can be clamped", async () => {
    const clock = fakeClock();
    const remaining = await runWithDeadline(
      undefined,
      300_000,
      "iteration",
      async (handle) => {
        clock.advance(120_000);
        return Math.min(5 * 60_000, handle.remainingMs());
      },
      { now: clock.now },
    );
    expect(remaining).toBe(180_000);
  });
});

it.each(["setup", "discovery"] as const)(
  "recognizes the %s clock after its deadline fires",
  (clock) => {
    vi.useFakeTimers();
    const deadline = withDeadline(undefined, 1, clock);
    vi.advanceTimersByTime(1);
    expect(deadlineClockOf(deadline.signal.reason)).toBe(clock);
    expect(
      deadlineClockOf(new Error("wrapped", { cause: deadline.signal.reason })),
    ).toBe(clock);
    deadline.dispose();
  },
);
