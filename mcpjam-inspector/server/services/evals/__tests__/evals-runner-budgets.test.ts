import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EXECUTION_BUDGET_DEFAULTS,
  resolveExecutionBudgetsForSurface,
  type ExecutionBudgetResolution,
} from "@mcpjam/sdk/contract";
import { defaultEvalExecutionBudgets } from "../../evals-runner.js";
import { EVAL_SANDBOX_CAPACITY_POLICY } from "../../../utils/run-supervisor/capacity-retry.js";
import { PLAYGROUND_CAPACITY_POLICY } from "../../../utils/run-supervisor/capacity-retry.js";
import { provisionEvalSandbox } from "../../../utils/computers/control-plane-client.js";

/**
 * The eval runner's end of the execution-budget contract.
 *
 * `runIterationUnderBudget` — the clock itself — is pinned in
 * `evals-runner.test.ts`. What is pinned HERE is everything around it: that
 * the runner's idea of a default is the contract's idea of a default, that the
 * sandbox path waits on a queue instead of failing the iteration on it, and
 * that the eval policy is deliberately not the Playground's.
 */

/** The platform-default eval resolution, unwrapped. Never a violation. */
function resolvedEvalDefaults() {
  const resolution: ExecutionBudgetResolution =
    resolveExecutionBudgetsForSurface({ surface: "evals" });
  if (!resolution.ok) {
    throw new Error(
      `the platform defaults must resolve: ${JSON.stringify(resolution.violations)}`,
    );
  }
  return resolution.resolved;
}

describe("defaultEvalExecutionBudgets", () => {
  it("is the contract's resolved defaults, not a second copy of the numbers", () => {
    // The runner uses this whenever a run launched before the backend froze
    // budgets into its snapshot — which today is every run. If it drifted from
    // the contract, the ceiling checks, the settings UI and the actual clocks
    // would each be enforcing a different set of numbers.
    expect(defaultEvalExecutionBudgets()).toEqual(resolvedEvalDefaults());
  });

  it("reports every field as coming from the default rung", () => {
    // Provenance matters for the settings surface: a field nobody authored has
    // to render as inherited, not as a choice someone made.
    const { sources } = resolvedEvalDefaults();
    for (const [field, source] of Object.entries(sources)) {
      expect(source, `${field} should be defaulted`).toBe("default");
    }
  });

  it("uses the eval unit clock, never the swarm one", () => {
    // `unitTimeoutMs` is the RESOLVED spelling of two different authored
    // fields — `iterationTimeoutMs` here, `sessionTimeoutMs` for swarms — and
    // the two surfaces do not share a number.
    const budgets = defaultEvalExecutionBudgets();
    expect(budgets.unitTimeoutMs).toBe(
      EXECUTION_BUDGET_DEFAULTS.evals.unitTimeoutMs,
    );
    expect(budgets.unitTimeoutMs).not.toBe(
      EXECUTION_BUDGET_DEFAULTS.swarms.unitTimeoutMs,
    );
  });

  it("leaves room for several turns inside one iteration", () => {
    // Not arithmetic for its own sake: a turn budget at or above the iteration
    // budget makes the iteration clock unreachable, and every timeout would be
    // attributed to the wrong layer.
    const budgets = defaultEvalExecutionBudgets();
    expect(budgets.turnTimeoutMs).toBeLessThan(budgets.unitTimeoutMs);
    expect(budgets.unitTimeoutMs).toBeLessThan(budgets.runTimeoutMs);
  });
});

describe("EVAL_SANDBOX_CAPACITY_POLICY", () => {
  it("fits inside one iteration's default budget", () => {
    // This wait is spent INSIDE the iteration clock. A capacity ceiling at or
    // above it would let a queue consume the whole iteration and leave nothing
    // for the work it was queued for.
    expect(EVAL_SANDBOX_CAPACITY_POLICY.totalBudgetMs).toBeLessThan(
      defaultEvalExecutionBudgets().unitTimeoutMs,
    );
  });

  it("jitters, unlike the Playground policy", () => {
    // A suite launches its iterations together. Without jitter a full pool is
    // re-polled by all of them on the same tick — the thundering herd one
    // waiting Playground user cannot produce.
    expect(EVAL_SANDBOX_CAPACITY_POLICY.jitter).toBeTypeOf("function");
    expect(PLAYGROUND_CAPACITY_POLICY).not.toHaveProperty("jitter");
  });

  it("caps attempts, and waits less than the Playground does", () => {
    expect(EVAL_SANDBOX_CAPACITY_POLICY.maxAttempts).toBeGreaterThan(1);
    expect(EVAL_SANDBOX_CAPACITY_POLICY.totalBudgetMs).toBeLessThan(
      PLAYGROUND_CAPACITY_POLICY.totalBudgetMs,
    );
  });
});

describe("provisionEvalSandbox — capacity", () => {
  const realFetch = global.fetch;
  let previousConvexHttpUrl: string | undefined;
  let requests: number;
  let respond: () => Response;

  beforeEach(() => {
    previousConvexHttpUrl = process.env.CONVEX_HTTP_URL;
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
    requests = 0;
    respond = () => new Response("{}", { status: 200 });
    global.fetch = vi.fn(async () => {
      requests += 1;
      return respond();
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    if (previousConvexHttpUrl === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = previousConvexHttpUrl;
    }
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  const args = { bearer: "token", runId: "r1", iterationId: "i1" };

  it("returns a successful provision on the first attempt", async () => {
    respond = () =>
      new Response(JSON.stringify({ sandboxId: "s1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    await expect(provisionEvalSandbox(args)).resolves.toMatchObject({
      ok: true,
    });
    expect(requests).toBe(1);
  });

  it("hands back a non-capacity refusal immediately, without retrying", async () => {
    // A 409 is an ANSWER — no image pinned, attempt not running. Waiting on it
    // buys nothing and spends the iteration's clock.
    respond = () =>
      new Response(JSON.stringify({ error: "no image", code: "no_image" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
    await expect(provisionEvalSandbox(args)).resolves.toMatchObject({
      ok: false,
      status: 409,
    });
    expect(requests).toBe(1);
  });

  it("waits out a 503 at_capacity and succeeds on the retry", async () => {
    // The whole point of the loop: a full pool is a QUEUE, not a verdict.
    // Before this, a suite that happened to launch while the pool was
    // saturated recorded genuine failures, and a capacity blip read as a
    // quality regression on the run's chart.
    //
    // Fake timers because the real first wait is 15 seconds; the assertion is
    // that the SECOND attempt happens at all, and only after a wait.
    vi.useFakeTimers();
    try {
      respond = () =>
        requests === 1
          ? new Response(
              JSON.stringify({ error: "full", code: "at_capacity" }),
              {
                status: 503,
                headers: { "content-type": "application/json" },
              },
            )
          : new Response(JSON.stringify({ sandboxId: "s1" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });

      const pending = provisionEvalSandbox(args);
      // Let the first attempt settle, then confirm the loop is WAITING rather
      // than having already given up or already re-fired.
      await vi.advanceTimersByTimeAsync(0);
      expect(requests).toBe(1);

      await vi.advanceTimersByTimeAsync(
        EVAL_SANDBOX_CAPACITY_POLICY.maxDelayMs,
      );
      await expect(pending).resolves.toMatchObject({ ok: true });
      expect(requests).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up in real time when a 503 outlives the budget, keeping the control plane's own words", async () => {
    // The whole point of the retry: a full pool is a QUEUE, not a verdict.
    // Before this, a suite that happened to launch while the pool was
    // saturated recorded genuine failures, and a capacity blip read as a
    // quality regression on the run's chart.
    //
    // Asserted through a budget too small for the first wait to fit, so the
    // loop reaches its terminal in real time rather than the test waiting out
    // a real backoff.
    respond = () =>
      new Response(
        JSON.stringify({
          error: "full",
          code: "at_capacity",
          resource: "desktops",
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    const result = await provisionEvalSandbox({ ...args, timeoutMs: 1 });
    // The control plane's OWN refusal is relayed — its status, its code, its
    // `resource` — rather than a message this layer invented about a failure
    // it only passed along.
    expect(result).toMatchObject({
      ok: false,
      status: 503,
      code: "at_capacity",
      resource: "desktops",
    });
    // It really did try, and really did stop.
    expect(requests).toBeGreaterThanOrEqual(1);
    expect(requests).toBeLessThanOrEqual(
      EVAL_SANDBOX_CAPACITY_POLICY.maxAttempts,
    );
  });
});
