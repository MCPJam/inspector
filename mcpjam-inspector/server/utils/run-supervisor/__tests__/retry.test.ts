import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CONTROL_PLANE_WRITE_RETRY_POLICY,
  RetryBudgetExhaustedError,
  backoffDelayMs,
  classifyRetry,
  retryAfterMsOf,
  withRetry,
  type RetryClass,
  type WithRetryPolicy,
} from "../retry.js";

afterEach(() => {
  vi.useRealTimers();
});

/** Deterministic test harness: no jitter, no real waiting, no real clock. */
function harness(overrides: Partial<WithRetryPolicy> = {}) {
  let current = 0;
  const waits: number[] = [];
  const policy: WithRetryPolicy = {
    maxAttempts: 3,
    baseDelayMs: 100,
    maxDelayMs: 1_000,
    totalBudgetMs: 10_000,
    jitter: (delayMs) => delayMs,
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
    advance: (ms: number) => {
      current += ms;
    },
    now: () => current,
  };
}

function httpError(status: number, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`request failed (${status})`), {
    status,
    ...extra,
  });
}

describe("classifyRetry — one fixture per class", () => {
  const cases: Array<[string, unknown, RetryClass]> = [
    [
      "a DOMException-shaped abort",
      Object.assign(new Error("aborted"), { name: "AbortError" }),
      "aborted",
    ],
    [
      "Node's ABORT_ERR code",
      Object.assign(new Error("x"), { code: "ABORT_ERR" }),
      "aborted",
    ],
    [
      "a 503 with at_capacity",
      httpError(503, { code: "at_capacity" }),
      "capacity",
    ],
    [
      "a 503 with sandbox_at_capacity",
      httpError(503, { code: "sandbox_at_capacity" }),
      "capacity",
    ],
    ["a bare 503", httpError(503), "transient"],
    ["a 500", httpError(500), "transient"],
    ["a 429", httpError(429), "rate_limited"],
    [
      "provider rate-limit prose",
      new Error("Rate limit exceeded, slow down"),
      "rate_limited",
    ],
    [
      "an org spend cap",
      httpError(429, { code: "spend_budget_reached" }),
      "terminal",
    ],
    ["a wallet lock", new Error("wallet_locked"), "terminal"],
    [
      "the runner's own whole-run stop",
      httpError(402, { code: "spend_cap_exceeded" }),
      "terminal",
    ],
    ["a 401", httpError(401), "terminal"],
    ["a 404", httpError(404), "terminal"],
    [
      "a schema failure",
      new Error("response did not match the expected schema"),
      "terminal",
    ],
    ["a socket hang up", new Error("socket hang up"), "transient"],
    [
      "a DNS blip",
      Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" }),
      "transient",
    ],
    [
      "an exhausted retry budget",
      new RetryBudgetExhaustedError(3, 10_000),
      "terminal",
    ],
    ["a non-error", "something went wrong", "terminal"],
    ["null", null, "terminal"],
  ];

  it.each(cases)("classifies %s", (_label, error, expected) => {
    expect(classifyRetry(error).class).toBe(expected);
  });

  it("puts abort ahead of transient, whatever the message says", () => {
    // An abort's message very often contains "timed out", which the SDK's
    // transient matcher reads as retryable. Retrying a cancelled run is the
    // worst outcome in the set, so the order is the contract.
    const aborted = Object.assign(new Error("The operation timed out"), {
      name: "AbortError",
      status: 503,
      code: "at_capacity",
    });
    expect(classifyRetry(aborted).class).toBe("aborted");
  });

  it("puts an account limit ahead of a rate limit", () => {
    // Both are 429-shaped and need opposite handling: waiting does not refill
    // a wallet.
    const accountLimit = httpError(429, {
      code: "user_rate_limit",
      retryAfterMs: 9_259_503,
    });
    expect(classifyRetry(accountLimit).class).toBe("terminal");
  });

  it("puts capacity ahead of transient", () => {
    // A 503 passes the SDK's transient test too. Capacity waits in minutes
    // against a shared pool; treating it as an ordinary 5xx makes the queue
    // worse.
    expect(classifyRetry(httpError(503, { code: "at_capacity" })).class).toBe(
      "capacity",
    );
  });

  it("does not read provider capacity wording as a spend cap", () => {
    // `classifyTurnFailure` word-anchors `\bcap\b` precisely so "capacity" does
    // NOT match it — a full pool is retryable, a spend cap never is. Pinned
    // here because this module is what depends on that anchoring.
    const capacityProse = Object.assign(new Error("sandbox at capacity"), {
      status: 503,
    });
    expect(classifyRetry(capacityProse).class).toBe("transient");
  });

  it("reads a status the SDK's own extractor cannot see", () => {
    // `isRetryableTransientError` looks at `statusCode` and a numeric `code`,
    // never `status` or `response.status` — which is exactly how `fetch` and
    // this codebase's ControlPlaneResult failures spell it. Without the
    // normalization, every one of those 5xx would classify `terminal`.
    expect(classifyRetry({ status: 502, error: "bad gateway" }).class).toBe(
      "transient",
    );
    expect(
      classifyRetry({ response: { status: 500 }, error: "boom" }).class,
    ).toBe("transient");
    expect(classifyRetry({ statusCode: 500 }).class).toBe("transient");
    // ...and the SDK's own exceptions to the 5xx rule survive it.
    expect(classifyRetry({ status: 501 }).class).toBe("terminal");
    expect(classifyRetry({ status: 403 }).class).toBe("terminal");
  });

  it("lets a status the failure carried outrank rate-limit prose", () => {
    // `classifyTurnFailure` is for the local-BYOK path, which attaches no code
    // or status, so prose is all that survives there. Letting it outrank a
    // status the failure DID carry reads a 500 mentioning a rate limit as
    // `rate_limited` — never retried at all without a `Retry-After` — and a
    // 403 with the same words as retryable.
    expect(
      classifyRetry(
        Object.assign(new Error("upstream rate limit exceeded"), {
          status: 500,
        }),
      ).class,
    ).toBe("transient");
    expect(
      classifyRetry(
        Object.assign(new Error("rate limit exceeded"), {
          status: 403,
          retryAfterMs: 1_000,
        }),
      ).class,
    ).toBe("terminal");
    // ...while a 429 is still a rate limit, and prose still decides when the
    // failure carried no status at all.
    expect(classifyRetry(httpError(429)).class).toBe("rate_limited");
    expect(classifyRetry(new Error("429 too many requests")).class).toBe(
      "rate_limited",
    );
  });

  it("carries Retry-After onto the classification when the failure sent one", () => {
    expect(
      classifyRetry(
        httpError(503, { code: "at_capacity", retryAfterMs: 45_000 }),
      ),
    ).toEqual({ class: "capacity", retryAfterMs: 45_000 });
  });
});

describe("retryAfterMsOf — units", () => {
  it("reads retryAfterMs and retryAfter as milliseconds", () => {
    expect(retryAfterMsOf({ retryAfterMs: 30_000 })).toBe(30_000);
    // The swarm agent's JSON envelope: `"retryAfter":9259503` alongside "Try
    // again in 155 minutes" — milliseconds, not seconds.
    expect(retryAfterMsOf({ retryAfter: 9_259_503 })).toBe(9_259_503);
  });

  it("reads a raw Retry-After header as SECONDS", () => {
    // The one place the units differ, and the one place getting it wrong turns
    // a 30-second wait into an eight-hour one.
    const error = {
      response: { headers: new Headers({ "retry-after": "30" }) },
    };
    expect(retryAfterMsOf(error)).toBe(30_000);
  });

  it("reads an HTTP-date Retry-After as the wait until that instant", () => {
    // RFC 9110 allows either `delay-seconds` or an HTTP-date. Returning
    // `undefined` for the date form means `withRetry` schedules no retry at all
    // on a 429 that used it.
    const now = Date.parse("2026-09-15T00:00:00Z");
    const error = {
      response: {
        headers: new Headers({
          "retry-after": "Tue, 15 Sep 2026 00:00:45 GMT",
        }),
      },
    };
    expect(retryAfterMsOf(error, () => now)).toBe(45_000);
    // A date already past is not a wait.
    expect(retryAfterMsOf(error, () => now + 60_000)).toBeUndefined();
  });

  it("ignores nonsense rather than guessing", () => {
    expect(retryAfterMsOf({ retryAfterMs: -1 })).toBeUndefined();
    expect(retryAfterMsOf({ retryAfterMs: Number.NaN })).toBeUndefined();
    expect(
      retryAfterMsOf({
        response: { headers: new Headers({ "retry-after": "soon" }) },
      }),
    ).toBeUndefined();
    // Numeric but negative is a malformed header, not a date — it must not
    // fall through to `Date.parse`, which would read "-5" as a year.
    expect(
      retryAfterMsOf({
        response: { headers: new Headers({ "retry-after": "-5" }) },
      }),
    ).toBeUndefined();
    expect(retryAfterMsOf(new Error("plain"))).toBeUndefined();
  });
});

describe("backoffDelayMs — invariants", () => {
  const policy = { baseDelayMs: 1_000, maxDelayMs: 8_000 };

  it("doubles from the base and caps at the max", () => {
    const flat = { ...policy, jitter: (d: number) => d };
    expect([1, 2, 3, 4, 5, 6].map((n) => backoffDelayMs(n, flat))).toEqual([
      1_000, 2_000, 4_000, 8_000, 8_000, 8_000,
    ]);
  });

  it("never exceeds the max and never goes negative, under any jitter", () => {
    // The invariant, asserted rather than sampled — the shape
    // `mcp-retry-policy.test.ts` uses for the MCP connect policy.
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      for (let trial = 0; trial < 50; trial += 1) {
        const delay = backoffDelayMs(attempt, policy);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(policy.maxDelayMs);
      }
    }
  });

  it("defaults to uniform(0.5, 1.0) of the computed delay", () => {
    // Jitter so callers that hit a limit together don't retry in lockstep and
    // keep colliding.
    const samples = Array.from({ length: 200 }, () =>
      backoffDelayMs(4, policy),
    );
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(4_000);
    expect(Math.max(...samples)).toBeLessThanOrEqual(8_000);
    expect(new Set(samples).size).toBeGreaterThan(1);
  });
});

describe("withRetry — what it retries", () => {
  it("returns the first success without waiting", async () => {
    const h = harness();
    const op = vi.fn(async () => "ok");
    await expect(withRetry(op, h.policy)).resolves.toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
    expect(h.waits).toEqual([]);
  });

  it("retries a transient failure with exponential backoff", async () => {
    const h = harness();
    let calls = 0;
    const result = await withRetry(async () => {
      calls += 1;
      if (calls < 3) throw httpError(500);
      return "ok";
    }, h.policy);

    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(h.waits).toEqual([100, 200]);
  });

  it("never retries a terminal failure", async () => {
    const h = harness();
    const op = vi.fn(async () => {
      throw httpError(401);
    });
    await expect(withRetry(op, h.policy)).rejects.toMatchObject({
      status: 401,
    });
    expect(op).toHaveBeenCalledTimes(1);
    expect(h.waits).toEqual([]);
  });

  it("never retries an abort", async () => {
    const h = harness();
    const op = vi.fn(async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    await expect(withRetry(op, h.policy)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("retries an attempt that ran out of its OWN time", async () => {
    // The bug this pins: the per-attempt deadline raises an AbortError, which
    // classifies `aborted`, which ended the sequence — so a per-attempt timeout
    // inside a retry loop meant "one try, then give up", the exact opposite of
    // why it exists.
    const h = harness({
      maxAttempts: 3,
      attemptTimeoutMs: 20,
      clock: "toolCall",
    });
    let calls = 0;
    const result = await withRetry(async (_attempt, signal) => {
      calls += 1;
      if (calls < 3) {
        // What a well-behaved op does when its own deadline fires.
        await new Promise((resolve) => setTimeout(resolve, 40));
        throw signal.reason ?? new Error("no reason");
      }
      return "ok";
    }, h.policy);

    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(h.waits).toEqual([100, 200]);
  });

  it("still stops when the CALLER cancels mid-attempt", async () => {
    // The other half of the same decision: a caller-level cancel is not an
    // attempt expiry, whatever clock rides on the composed signal's reason.
    const controller = new AbortController();
    const h = harness({
      maxAttempts: 3,
      attemptTimeoutMs: 20,
      clock: "toolCall",
    });
    const op = vi.fn(async (_attempt: number, signal: AbortSignal) => {
      controller.abort();
      throw signal.reason ?? new Error("no reason");
    });
    await expect(
      withRetry(op, { ...h.policy, signal: controller.signal }),
    ).rejects.toBeDefined();
    expect(op).toHaveBeenCalledTimes(1);
    expect(h.waits).toEqual([]);
  });

  it("stops retrying once the caller's signal aborts", async () => {
    const controller = new AbortController();
    const h = harness({ signal: controller.signal });
    const op = vi.fn(async () => {
      controller.abort();
      throw httpError(500);
    });
    await expect(withRetry(op, h.policy)).rejects.toBeDefined();
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("retries a rate limit ONLY against a known Retry-After", async () => {
    // Without one we do not know whether the window is seconds or hours, and
    // guessing is how a retry loop turns a throttle into a ban.
    const blind = harness();
    const blindOp = vi.fn(async () => {
      throw httpError(429);
    });
    await expect(withRetry(blindOp, blind.policy)).rejects.toBeDefined();
    expect(blindOp).toHaveBeenCalledTimes(1);

    const told = harness();
    let calls = 0;
    await withRetry(async () => {
      calls += 1;
      if (calls === 1) throw httpError(429, { retryAfterMs: 500 });
      return "ok";
    }, told.policy);
    expect(told.waits).toEqual([500]);
  });

  it("clamps Retry-After into [base, max]", async () => {
    // A control plane cannot talk a caller into a wait outside its own policy.
    const low = harness();
    await withRetry(
      makeFailThenSucceed(() => httpError(503, { retryAfterMs: 1 })),
      low.policy,
    );
    expect(low.waits).toEqual([low.policy.baseDelayMs]);

    const high = harness();
    await withRetry(
      makeFailThenSucceed(() => httpError(503, { retryAfterMs: 10 * 60_000 })),
      high.policy,
    );
    expect(high.waits).toEqual([high.policy.maxDelayMs]);
  });
});

describe("withRetry — budgets", () => {
  it("caps attempts at maxAttempts and throws the last failure", async () => {
    const h = harness({ maxAttempts: 3 });
    const op = vi.fn(async () => {
      throw httpError(500, { marker: "last" });
    });
    await expect(withRetry(op, h.policy)).rejects.toMatchObject({
      marker: "last",
    });
    expect(op).toHaveBeenCalledTimes(3);
    expect(h.waits).toEqual([100, 200]);
  });

  it("stops when the next wait would not fit the total budget", async () => {
    // Sleeping right up to the deadline and then failing spends the whole
    // budget proving nothing.
    const h = harness({ maxAttempts: 10, totalBudgetMs: 350 });
    const op = vi.fn(async () => {
      throw httpError(500);
    });
    await expect(withRetry(op, h.policy)).rejects.toBeDefined();
    // 100 then 200 fit inside 350; the third wait (400) does not.
    expect(h.waits).toEqual([100, 200]);
    expect(op).toHaveBeenCalledTimes(3);
  });

  it("keeps total elapsed inside the budget, whatever the attempt count", async () => {
    for (const totalBudgetMs of [0, 1, 250, 1_000, 5_000]) {
      const h = harness({ maxAttempts: 50, totalBudgetMs });
      await expect(
        withRetry(async () => {
          throw httpError(500);
        }, h.policy),
      ).rejects.toBeDefined();
      expect(h.waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(
        totalBudgetMs,
      );
    }
  });

  it("raises RetryBudgetExhaustedError when there is no time for attempt one", async () => {
    const h = harness({ totalBudgetMs: 0 });
    const op = vi.fn(async () => "never");
    await expect(withRetry(op, h.policy)).rejects.toBeInstanceOf(
      RetryBudgetExhaustedError,
    );
    expect(op).not.toHaveBeenCalled();
  });

  it("clamps each attempt's own deadline to the remaining budget", async () => {
    const h = harness({ attemptTimeoutMs: 60_000, totalBudgetMs: 5_000 });
    const budgets: number[] = [];
    await withRetry(async (_attempt, signal) => {
      // The signal the op is handed is the attempt deadline, not the caller's:
      // a hung call is cut loose while the sequence keeps its remaining budget.
      budgets.push(signal.aborted ? 0 : 1);
      return "ok";
    }, h.policy);
    expect(budgets).toEqual([1]);
  });

  it("reports each wait so a caller can sum waitedMs", async () => {
    const h = harness();
    const seen: Array<{ attempt: number; delayMs: number; cls: string }> = [];
    let calls = 0;
    await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw httpError(500);
        return "ok";
      },
      {
        ...h.policy,
        onRetry: ({ attempt, delayMs, classification }) =>
          seen.push({ attempt, delayMs, cls: classification.class }),
      },
    );
    expect(seen).toEqual([
      { attempt: 1, delayMs: 100, cls: "transient" },
      { attempt: 2, delayMs: 200, cls: "transient" },
    ]);
    // §10: the `waitedMs` an iteration records is the sum of these.
    expect(seen.reduce((sum, r) => sum + r.delayMs, 0)).toBe(300);
  });

  it("reports the delay it actually sleeps, even under random jitter", async () => {
    // Regression guard: computing the delay once for the budget check and
    // again for the sleep would check one number and wait a different one.
    const slept: number[] = [];
    let current = 0;
    const reported: number[] = [];
    let calls = 0;
    await withRetry(
      async () => {
        calls += 1;
        if (calls < 4) throw httpError(500);
        return "ok";
      },
      {
        maxAttempts: 5,
        baseDelayMs: 1_000,
        maxDelayMs: 8_000,
        totalBudgetMs: 60_000,
        now: () => current,
        sleep: async (ms) => {
          slept.push(ms);
          current += ms;
        },
        onRetry: ({ delayMs }) => reported.push(delayMs),
      },
    );
    expect(slept).toEqual(reported);
  });
});

describe("withRetry — with real timers", () => {
  it("actually waits, and the sequence completes", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const promise = withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw httpError(500);
        return "ok";
      },
      {
        maxAttempts: 3,
        baseDelayMs: 1_000,
        maxDelayMs: 10_000,
        totalBudgetMs: 60_000,
        jitter: (delayMs) => delayMs,
      },
    );

    await vi.advanceTimersByTimeAsync(3_000);
    await expect(promise).resolves.toBe("ok");
    expect(calls).toBe(3);
  });
});

describe("CONTROL_PLANE_WRITE_RETRY_POLICY", () => {
  it("bounds the worst case a claim or report can add", () => {
    // These are on the critical path of a unit reaching a terminal state: a
    // claim that cannot land in fifteen seconds is better surfaced than waited
    // on.
    expect(CONTROL_PLANE_WRITE_RETRY_POLICY.maxAttempts).toBeGreaterThanOrEqual(
      2,
    );
    expect(CONTROL_PLANE_WRITE_RETRY_POLICY.totalBudgetMs).toBeLessThanOrEqual(
      15_000,
    );
    expect(CONTROL_PLANE_WRITE_RETRY_POLICY.maxDelayMs).toBeLessThanOrEqual(
      CONTROL_PLANE_WRITE_RETRY_POLICY.totalBudgetMs,
    );
    expect(CONTROL_PLANE_WRITE_RETRY_POLICY.baseDelayMs).toBeLessThanOrEqual(
      CONTROL_PLANE_WRITE_RETRY_POLICY.maxDelayMs,
    );
  });
});

function makeFailThenSucceed(error: () => unknown): () => Promise<string> {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls === 1) throw error();
    return "ok";
  };
}
