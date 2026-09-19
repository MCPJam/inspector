import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PLAYGROUND_CAPACITY_POLICY,
  withCapacityRetry,
  type CapacityRetryPolicy,
} from "../capacity-retry.js";

afterEach(() => {
  vi.useRealTimers();
});

type Probe = {
  ok: boolean;
  status?: number;
  code?: string;
  retryAfterMs?: number;
};

/** A virtual clock plus a sleep that advances it. No fake timers needed. */
function bench(overrides: Partial<CapacityRetryPolicy<Probe>> = {}) {
  let current = 0;
  const waits: number[] = [];
  const policy: CapacityRetryPolicy<Probe> = {
    shouldRetry: (result) => !result.ok,
    baseDelayMs: 1_000,
    maxDelayMs: 8_000,
    totalBudgetMs: 60_000,
    now: () => current,
    sleep: async (ms) => {
      waits.push(ms);
      current += ms;
    },
    ...overrides,
  };
  return {
    policy,
    waits,
    advance: (ms: number) => (current += ms),
    now: () => current,
  };
}

const full: Probe = { ok: false, status: 503, code: "at_capacity" };
const ready: Probe = { ok: true };

describe("withCapacityRetry — settling", () => {
  it("returns the first non-retryable result without waiting", async () => {
    const b = bench();
    const outcome = await withCapacityRetry(async () => ready, b.policy);
    expect(outcome).toEqual({
      kind: "settled",
      result: ready,
      attempts: 1,
      waitedMs: 0,
    });
    expect(b.waits).toEqual([]);
  });

  it("settles on a result the policy does not claim, ok or not", async () => {
    // A hard refusal is an ANSWER, not a reason to keep waiting: the loop hands
    // it straight back and the caller decides.
    const b = bench({ shouldRetry: (r) => !r.ok && r.status === 503 });
    const refusal: Probe = { ok: false, status: 409, code: "no_image" };
    const outcome = await withCapacityRetry(async () => refusal, b.policy);
    expect(outcome).toMatchObject({
      kind: "settled",
      result: refusal,
      attempts: 1,
    });
  });

  it("retries until it settles, with exponential backoff", async () => {
    const b = bench({ jitter: (d) => d });
    let calls = 0;
    const outcome = await withCapacityRetry(async () => {
      calls += 1;
      return calls < 4 ? full : ready;
    }, b.policy);

    expect(outcome).toMatchObject({
      kind: "settled",
      result: ready,
      attempts: 4,
    });
    expect(b.waits).toEqual([1_000, 2_000, 4_000]);
    expect(outcome.kind === "settled" && outcome.waitedMs).toBe(7_000);
  });
});

describe("withCapacityRetry — bounds", () => {
  it("stops after maxAttempts and names why", async () => {
    const b = bench({ maxAttempts: 3, jitter: (d) => d });
    const op = vi.fn(async () => full);
    const outcome = await withCapacityRetry(op, b.policy);

    expect(op).toHaveBeenCalledTimes(3);
    expect(outcome).toMatchObject({
      kind: "exhausted",
      reason: "attempts_exhausted",
      lastResult: full,
      attempts: 3,
    });
    // Three attempts, two waits — never a trailing sleep nobody is waiting on.
    expect(b.waits).toEqual([1_000, 2_000]);
  });

  it("stops in front of a wait that would not fit the budget", async () => {
    const b = bench({ totalBudgetMs: 3_500, jitter: (d) => d });
    const outcome = await withCapacityRetry(async () => full, b.policy);

    expect(b.waits).toEqual([1_000, 2_000]);
    expect(outcome).toMatchObject({
      kind: "exhausted",
      reason: "budget_before_delay",
      // The wait it was ABOUT to take: the Playground turns this into the
      // `retryAfterMs` on its terminal 503, so a caller knows what to tell a
      // user.
      plannedDelayMs: 4_000,
      attempts: 3,
    });
  });

  it("reports budget_exhausted when the clock dies at the top of a turn", async () => {
    // Distinct from `budget_before_delay`: this one carries no planned wait,
    // and the Playground's terminal shape differs accordingly.
    const b = bench({ totalBudgetMs: 0 });
    const op = vi.fn(async () => full);
    const outcome = await withCapacityRetry(op, b.policy);

    expect(op).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      kind: "exhausted",
      reason: "budget_exhausted",
      attempts: 0,
    });
    expect(
      outcome.kind === "exhausted" && outcome.plannedDelayMs,
    ).toBeUndefined();
  });

  it("runs unbounded attempts when only a wall clock bounds it", async () => {
    const b = bench({
      totalBudgetMs: 12_000,
      baseDelayMs: 1_000,
      maxDelayMs: 1_000,
    });
    const op = vi.fn(async () => full);
    const outcome = await withCapacityRetry(op, b.policy);
    // Twelve one-second waits is more attempts than any `maxAttempts` would
    // have allowed — the ceiling is time, not tries.
    expect(op.mock.calls.length).toBeGreaterThan(5);
    expect(outcome.kind).toBe("exhausted");
    expect(b.waits.reduce((a, c) => a + c, 0)).toBeLessThanOrEqual(12_000);
  });

  it("keeps waiting inside the budget for every budget size", async () => {
    for (const totalBudgetMs of [0, 1, 999, 5_000, 60_000]) {
      const b = bench({ totalBudgetMs, maxAttempts: 40 });
      const outcome = await withCapacityRetry(async () => full, b.policy);
      expect(b.waits.reduce((a, c) => a + c, 0)).toBeLessThanOrEqual(
        totalBudgetMs,
      );
      expect(
        outcome.kind === "exhausted" && outcome.waitedMs,
      ).toBeLessThanOrEqual(totalBudgetMs);
    }
  });
});

describe("withCapacityRetry — aborting", () => {
  it("stops at the loop head once the caller aborts", async () => {
    const controller = new AbortController();
    const b = bench({
      signal: controller.signal,
      maxAttempts: 5,
      jitter: (d) => d,
    });
    const op = vi.fn(async () => {
      controller.abort();
      return full;
    });
    const outcome = await withCapacityRetry(op, b.policy);

    // The abort is seen in front of the wait, which is where the Playground's
    // give-up shape is decided, so this is `budget_before_delay` — exactly as
    // the loop it replaces answered.
    expect(outcome).toMatchObject({
      kind: "exhausted",
      reason: "budget_before_delay",
    });
    expect(op).toHaveBeenCalledTimes(1);
    expect(b.waits).toEqual([]);
  });

  it("reports `aborted` when the signal trips during a wait", async () => {
    const controller = new AbortController();
    const b = bench({
      signal: controller.signal,
      maxAttempts: 5,
      sleep: async () => {
        controller.abort();
      },
    });
    const outcome = await withCapacityRetry(async () => full, b.policy);
    expect(outcome).toMatchObject({
      kind: "exhausted",
      reason: "aborted",
      attempts: 1,
    });
  });

  it("gives each attempt its own deadline, clamped to the remaining budget", async () => {
    const b = bench({
      attemptTimeoutMs: 30_000,
      totalBudgetMs: 5_000,
      maxAttempts: 1,
    });
    let attemptSignal: AbortSignal | undefined;
    await withCapacityRetry(async (_attempt, signal) => {
      attemptSignal = signal;
      return full;
    }, b.policy);
    // The signal handed to `op` is the attempt's, not the caller's: a control
    // plane that accepts the connection and then stalls costs ONE attempt.
    expect(attemptSignal).toBeInstanceOf(AbortSignal);
    expect(attemptSignal?.aborted).toBe(false);
  });

  it("tears the attempt deadline down even when op throws", async () => {
    vi.useFakeTimers();
    const before = vi.getTimerCount();
    await expect(
      withCapacityRetry(
        async () => {
          throw new Error("sandbox client blew up");
        },
        {
          shouldRetry: () => true,
          baseDelayMs: 1,
          maxDelayMs: 1,
          totalBudgetMs: 1_000,
        },
      ),
    ).rejects.toThrow("sandbox client blew up");
    expect(vi.getTimerCount()).toBe(before);
  });
});

describe("withCapacityRetry — Retry-After", () => {
  it("lets a server-sent wait override the computed backoff", async () => {
    const b = bench({
      jitter: (d) => d,
      retryAfterMsOf: (r) => r.retryAfterMs,
      maxAttempts: 2,
    });
    await withCapacityRetry(
      async () => ({ ...full, retryAfterMs: 5_000 }),
      b.policy,
    );
    expect(b.waits).toEqual([5_000]);
  });

  it("clamps it into the policy's own range", async () => {
    // A control plane cannot talk a caller into a wait outside its policy —
    // neither a hot-loop retry nor an hour-long park.
    const low = bench({
      retryAfterMsOf: (r) => r.retryAfterMs,
      maxAttempts: 2,
    });
    await withCapacityRetry(
      async () => ({ ...full, retryAfterMs: 1 }),
      low.policy,
    );
    expect(low.waits).toEqual([low.policy.baseDelayMs]);

    const high = bench({
      retryAfterMsOf: (r) => r.retryAfterMs,
      maxAttempts: 2,
    });
    await withCapacityRetry(
      async () => ({ ...full, retryAfterMs: 60 * 60_000 }),
      high.policy,
    );
    expect(high.waits).toEqual([high.policy.maxDelayMs]);
  });
});

/**
 * The three loops this shape has to serve are NOT equivalent, and each one's
 * numbers are the behaviour its surface shipped. These pin the two that exist
 * today; PR 2's eval-sandbox policy joins them when its call site lands.
 */
describe("withCapacityRetry — the shipped policies keep their own semantics", () => {
  it("reproduces the Playground delay sequence exactly", async () => {
    // Was: `delayMs` starting at 30s, `min(5min, max(30s, retryAfter ?? delayMs))`,
    // doubling to a 5-minute cap, inside a 10-minute deadline. No jitter.
    const b = bench({
      ...PLAYGROUND_CAPACITY_POLICY,
      shouldRetry: (r) => !r.ok && r.status === 503 && r.code === "at_capacity",
    });
    const outcome = await withCapacityRetry(async () => full, b.policy);

    // Ground truth, replayed from the loop this replaces: five attempts, four
    // waits, and a fifth wait of 300s that does not fit the 600s ceiling.
    expect(b.waits).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(outcome).toMatchObject({
      kind: "exhausted",
      reason: "budget_before_delay",
      plannedDelayMs: 300_000,
      attempts: 5,
    });
    expect(b.waits.reduce((a, c) => a + c, 0)).toBeLessThanOrEqual(
      PLAYGROUND_CAPACITY_POLICY.totalBudgetMs,
    );
  });

  it("keeps the Playground's 30-second floor under a server-sent wait", async () => {
    const b = bench({
      ...PLAYGROUND_CAPACITY_POLICY,
      shouldRetry: (r) => !r.ok && r.status === 503 && r.code === "at_capacity",
      retryAfterMsOf: (r) => r.retryAfterMs,
      maxAttempts: 2,
    });
    await withCapacityRetry(
      async () => ({ ...full, retryAfterMs: 5_000 }),
      b.policy,
    );
    expect(b.waits).toEqual([30_000]);
  });

  it("has no jitter on the Playground policy, and no attempt cap", () => {
    // One interactive user on a spinner: nothing to spread out, and the
    // ceiling means ten minutes, not a try count.
    expect(PLAYGROUND_CAPACITY_POLICY).not.toHaveProperty("jitter");
    expect(PLAYGROUND_CAPACITY_POLICY).not.toHaveProperty("maxAttempts");
    expect(PLAYGROUND_CAPACITY_POLICY.attemptTimeoutMs).toBe(30_000);
  });

  it("reproduces the swarm sandbox loop: five attempts, jittered 4s·2^(n-1) capped 45s", async () => {
    // Attempts, not wall clock — and jittered, because many targets hit
    // capacity together and must not retry in lockstep.
    const b = bench({
      maxAttempts: 5,
      baseDelayMs: 4_000,
      maxDelayMs: 45_000,
      totalBudgetMs: undefined,
      attemptTimeoutMs: 30_000,
      jitter: (d) => d * (0.5 + Math.random() * 0.5),
      shouldRetry: (r) => !r.ok && (r.status === 503 || r.status === 0),
    });
    const op = vi.fn(async () => full);
    const outcome = await withCapacityRetry(op, b.policy);

    expect(op).toHaveBeenCalledTimes(5);
    expect(outcome).toMatchObject({
      kind: "exhausted",
      reason: "attempts_exhausted",
    });
    expect(b.waits).toHaveLength(4);
    const unjittered = [4_000, 8_000, 16_000, 32_000];
    b.waits.forEach((wait, index) => {
      expect(wait).toBeGreaterThanOrEqual(unjittered[index]! * 0.5);
      expect(wait).toBeLessThanOrEqual(Math.min(45_000, unjittered[index]!));
    });
  });

  it("retries a network error for the swarm but not for the Playground", async () => {
    // `status 0` is a dropped connection. The swarm treats it as transient and
    // retries; the Playground hands it straight back. Collapsing the two
    // `shouldRetry` predicates into one would silently change one of them.
    const dropped: Probe = { ok: false, status: 0 };

    const swarm = bench({
      maxAttempts: 3,
      totalBudgetMs: undefined,
      shouldRetry: (r) => !r.ok && (r.status === 503 || r.status === 0),
    });
    const swarmOp = vi.fn(async () => dropped);
    await withCapacityRetry(swarmOp, swarm.policy);
    expect(swarmOp).toHaveBeenCalledTimes(3);

    const playground = bench({
      ...PLAYGROUND_CAPACITY_POLICY,
      shouldRetry: (r) => !r.ok && r.status === 503 && r.code === "at_capacity",
    });
    const playgroundOp = vi.fn(async () => dropped);
    const outcome = await withCapacityRetry(playgroundOp, playground.policy);
    expect(playgroundOp).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ kind: "settled", result: dropped });
  });
});

describe("withCapacityRetry — with real timers", () => {
  it("actually waits between attempts", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const promise = withCapacityRetry(
      async () => {
        calls += 1;
        return calls < 3 ? full : ready;
      },
      {
        shouldRetry: (r: Probe) => !r.ok,
        baseDelayMs: 1_000,
        maxDelayMs: 10_000,
        totalBudgetMs: 60_000,
        jitter: (d) => d,
      },
    );

    await vi.advanceTimersByTimeAsync(3_000);
    await expect(promise).resolves.toMatchObject({
      kind: "settled",
      attempts: 3,
    });
  });
});
