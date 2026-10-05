import { describe, expect, it, vi } from "vitest";
import {
  INFRA_RETRY_BREAKER_THRESHOLD,
  computeInfraRetryDelay,
  createRunInfraRetryBudget,
  decideInfraRetry,
  commitInfraRetry,
  minimumRetryHeadroomMs,
  noteAttemptOutcome,
  resolveMaxConcurrentCases,
  infraRetryEnabled,
} from "../infra-retry";
import {
  EffectDispatchRefusedError,
  createEffectDispatchGate,
  wrapToolSetWithEffectGate,
} from "../effect-dispatch-gate";

const NOW = 1_000_000;
const unavailable = {
  class: "provider_unavailable" as const,
  layer: "model" as const,
  retryable: true,
  httpStatus: 503,
};

function baseInput(overrides: Partial<Parameters<typeof decideInfraRetry>[0]> = {}) {
  return {
    enabled: true,
    suiteRunWithRecorder: true,
    harness: false,
    classified: unavailable,
    replay: { safe: true } as const,
    retriesSoFar: 0,
    aborted: false,
    creditsExhausted: false,
    now: NOW,
    deadlineAt: NOW + 10 * 60_000,
    unitTimeoutMs: 10 * 60_000,
    runBudget: createRunInfraRetryBudget(10),
    random: () => 0.5,
    ...overrides,
  };
}

describe("decideInfraRetry", () => {
  it("retries a replay-safe provider outage with the first backoff step", () => {
    expect(decideInfraRetry(baseInput())).toEqual({
      retry: true,
      delayMs: 5_000,
      delaySource: "backoff",
    });
  });

  it.each([
    ["flag_off", { enabled: false }],
    ["not_suite_run", { suiteRunWithRecorder: false }],
    ["harness_run", { harness: true }],
    [
      "class_not_retryable",
      { classified: { class: "auth", layer: "model", retryable: false } },
    ],
    [
      "class_not_retryable",
      { classified: { class: "account_limit", layer: "platform", retryable: false } },
    ],
    ["effects_dispatched", { replay: { safe: false, reason: "effects_dispatched" } }],
    ["attempt_state_missing", { replay: { safe: false, reason: "attempt_state_missing" } }],
    ["dispatch_marker_failed", { replay: { safe: false, reason: "dispatch_marker_failed" } }],
    ["max_retries", { retriesSoFar: 2 }],
    ["run_aborted", { aborted: true }],
    ["credits_exhausted", { creditsExhausted: true }],
  ] as const)("declines with %s", (reason, overrides) => {
    expect(decideInfraRetry(baseInput(overrides as never))).toEqual({
      retry: false,
      reason,
    });
  });

  it("never shortens a Retry-After: it is honoured exactly or declined", () => {
    expect(
      decideInfraRetry(
        baseInput({
          classified: { ...unavailable, class: "rate_limited", retryAfterMs: 45_000 },
        }),
      ),
    ).toEqual({ retry: true, delayMs: 45_000, delaySource: "retryAfter" });
    expect(
      decideInfraRetry(
        baseInput({
          classified: { ...unavailable, class: "rate_limited", retryAfterMs: 600_000 },
        }),
      ),
    ).toEqual({ retry: false, reason: "retry_after_exceeds_max_wait" });
  });

  it("declines when the wait would leave less than max(60s, 25%) of the budget", () => {
    // 10-minute unit: headroom = 150s. 100s left after a 5s wait → declined.
    expect(
      decideInfraRetry(baseInput({ deadlineAt: NOW + 105_000 })),
    ).toEqual({ retry: false, reason: "insufficient_budget" });
    // A Retry-After that fits the cap but not the remaining budget is
    // declined too, never shortened.
    expect(
      decideInfraRetry(
        baseInput({
          deadlineAt: NOW + 200_000,
          classified: { ...unavailable, class: "rate_limited", retryAfterMs: 100_000 },
        }),
      ),
    ).toEqual({ retry: false, reason: "insufficient_budget" });
    expect(minimumRetryHeadroomMs(60_000)).toBe(60_000);
    expect(minimumRetryHeadroomMs(20 * 60_000)).toBe(300_000);
  });

  it("caps retries per run and opens a breaker on a provider that stays down", () => {
    const budget = createRunInfraRetryBudget(4);
    expect(budget.max).toBe(3); // max(3, 25% of 4)
    expect(createRunInfraRetryBudget(40).max).toBe(10);
    for (let i = 0; i < 3; i++) commitInfraRetry(budget);
    expect(decideInfraRetry(baseInput({ runBudget: budget }))).toEqual({
      retry: false,
      reason: "run_retry_budget_exhausted",
    });

    const breaker = createRunInfraRetryBudget(100);
    for (let i = 0; i < INFRA_RETRY_BREAKER_THRESHOLD; i++) {
      noteAttemptOutcome(breaker, { infraClass: "provider_unavailable" });
    }
    expect(decideInfraRetry(baseInput({ runBudget: breaker }))).toEqual({
      retry: false,
      reason: "circuit_open",
    });
    // Any other outcome closes it again.
    noteAttemptOutcome(breaker, {});
    expect(decideInfraRetry(baseInput({ runBudget: breaker })).retry).toBe(true);
  });
});

describe("computeInfraRetryDelay", () => {
  it("uses 5s/20s for an unavailable provider and 30s/90s for limits, jittered", () => {
    const mid = () => 0.5;
    expect(
      computeInfraRetryDelay({ class: "provider_unavailable", retryIndex: 1, random: mid }),
    ).toMatchObject({ delayMs: 20_000 });
    expect(
      computeInfraRetryDelay({ class: "rate_limited", retryIndex: 0, random: mid }),
    ).toMatchObject({ delayMs: 30_000 });
    expect(
      computeInfraRetryDelay({ class: "capacity", retryIndex: 1, random: () => 1 }),
    ).toMatchObject({ delayMs: 108_000 });
    // ±20% jitter, never above the 120s cap.
    const low = computeInfraRetryDelay({
      class: "provider_unavailable",
      retryIndex: 0,
      random: () => 0,
    });
    expect(low).toMatchObject({ delayMs: 4_000 });
  });
});

describe("flags", () => {
  it("parses the fan-out cap like the render-check cap, clamped 1–64", () => {
    expect(resolveMaxConcurrentCases({})).toBe(8);
    expect(resolveMaxConcurrentCases({ MCPJAM_EVAL_MAX_CONCURRENT_CASES: "3" })).toBe(3);
    expect(resolveMaxConcurrentCases({ MCPJAM_EVAL_MAX_CONCURRENT_CASES: "0" })).toBe(1);
    expect(resolveMaxConcurrentCases({ MCPJAM_EVAL_MAX_CONCURRENT_CASES: "500" })).toBe(64);
    expect(resolveMaxConcurrentCases({ MCPJAM_EVAL_MAX_CONCURRENT_CASES: "x" })).toBe(8);
  });

  it("retry is off unless enabled", () => {
    expect(infraRetryEnabled({})).toBe(false);
    expect(infraRetryEnabled({ MCPJAM_EVAL_INFRA_RETRY: "1" })).toBe(true);
  });
});

describe("effect dispatch gate", () => {
  it("is replay-safe until the first dispatch, then never again", async () => {
    const persistMarker = vi.fn(async () => {});
    const gate = createEffectDispatchGate({
      attempt: 1,
      attemptId: "a1",
      armed: true,
      persistMarker,
    });
    expect(gate.replaySafety()).toEqual({ safe: true });
    await gate.admit("tool");
    await gate.admit("tool");
    // ONE marker write per attempt, however many dispatches follow.
    expect(persistMarker).toHaveBeenCalledTimes(1);
    expect(gate.replaySafety()).toEqual({
      safe: false,
      reason: "effects_dispatched",
    });
  });

  it("refuses the dispatch — and every later one — when the marker cannot be written", async () => {
    const gate = createEffectDispatchGate({
      attempt: 1,
      attemptId: "a1",
      armed: true,
      persistMarker: async () => {
        throw new Error("convex down");
      },
    });
    const execute = vi.fn(async () => "ran");
    const tools = wrapToolSetWithEffectGate({ t: { execute } }, gate);
    await expect(
      (tools.t as { execute: () => Promise<unknown> }).execute(),
    ).rejects.toBeInstanceOf(EffectDispatchRefusedError);
    await expect(gate.admit("browser")).rejects.toBeInstanceOf(
      EffectDispatchRefusedError,
    );
    // The tool never ran.
    expect(execute).not.toHaveBeenCalled();
    expect(gate.replaySafety()).toEqual({
      safe: false,
      reason: "dispatch_marker_failed",
    });
  });

  it("an unarmed gate (attempt state missing) lets work run but forbids replay", async () => {
    const persistMarker = vi.fn(async () => {});
    const gate = createEffectDispatchGate({
      attempt: 1,
      attemptId: "a1",
      armed: false,
      persistMarker,
    });
    expect(gate.replaySafety()).toEqual({
      safe: false,
      reason: "attempt_state_missing",
    });
    await gate.admit("tool");
    expect(persistMarker).not.toHaveBeenCalled();
  });

  it("concurrent first dispatches share one marker write and both wait for it", async () => {
    let release!: () => void;
    const persistMarker = vi.fn(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const gate = createEffectDispatchGate({
      attempt: 1,
      attemptId: "a1",
      armed: true,
      persistMarker,
    });
    const order: string[] = [];
    const first = gate.admit("tool").then(() => order.push("first"));
    const second = gate.admit("tool").then(() => order.push("second"));
    await Promise.resolve();
    expect(order).toEqual([]);
    release();
    await Promise.all([first, second]);
    expect(persistMarker).toHaveBeenCalledTimes(1);
    expect(order).toHaveLength(2);
  });

  it("a leased row whose attempt is refused for ownership dispatches nothing", async () => {
    const { beginEffectDispatchGate } = await import("../effect-dispatch-gate");
    const { ConvexError } = await import("convex/values");
    const { LeaseLostError } = await import("../run-lease");
    for (const code of ["LEASE_LOST", "TRIAL_ATTEMPT_REFUSED"]) {
      const mutation = vi.fn(async () => {
        throw new ConvexError({ code, message: "not yours" });
      });
      await expect(
        beginEffectDispatchGate({
          convexClient: { mutation } as never,
          iterationId: "it-1",
          attempt: 1,
          leaseToken: "lease-1",
        }),
      ).rejects.toBeInstanceOf(LeaseLostError);
    }
    // Unleased (legacy) rows keep the permissive unarmed fallback.
    const unleased = await beginEffectDispatchGate({
      convexClient: {
        mutation: vi.fn(async () => {
          throw new Error("LEASE_LOST");
        }),
      } as never,
      iterationId: "it-legacy",
      attempt: 1,
    });
    expect(unleased.replaySafety()).toEqual({
      safe: false,
      reason: "attempt_state_missing",
    });
  });

  it("wrapping is a no-op without a gate", () => {
    const tools = { t: { execute: async () => 1 } };
    expect(wrapToolSetWithEffectGate(tools, undefined)).toBe(tools);
  });
});
