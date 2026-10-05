/**
 * E2 — retrying an infrastructure failure IN PLACE, safely.
 *
 * When OUR infrastructure fails a trial (E1 classified it: a provider 5xx, a
 * 429, a capacity wall), the trial measured nothing — so running it again is
 * the honest way to get the measurement the user asked for. "Again" is the
 * dangerous word: a new model call is cheap to repeat, a tool call against the
 * customer's MCP server is not. A new sandbox does not reset their server.
 *
 * So the one rule every automatic retry (here) and every restart recovery
 * (E4) shares: an attempt is restarted only with DURABLE PROOF that it never
 * dispatched anything potentially effectful — see `effect-dispatch-gate.ts`.
 * Missing or legacy state, an interrupted marker write, or incomplete
 * instrumentation all read as UNSAFE. Safety is never inferred from a tool's
 * name or annotations in v1.
 *
 * Everything else is budget. A retry shares the iteration's own clock and
 * abort signal (it runs inside `runIterationUnderBudget`), never shortens a
 * provider's Retry-After, and is capped per trial, per run, and by a circuit
 * breaker for a provider that is simply down. A retried trial is ONE
 * statistical trial: the final attempt is graded, earlier attempts are
 * diagnostic history and cost.
 *
 * This module is pure: the runner supplies every fact and applies the
 * decision.
 */
import type {
  EvalInfraError,
  EvalInfraErrorClass,
} from "@/shared/eval-infra-error";
import type { UsageTotals } from "./types";

/** Retries per trial, on top of the first attempt. */
export const INFRA_RETRY_MAX_RETRIES = 2;

/** Only failures that waiting can fix. Never auth, configuration, limits. */
export const INFRA_RETRYABLE_CLASSES: ReadonlySet<EvalInfraErrorClass> =
  new Set(["provider_unavailable", "rate_limited", "capacity"]);

/** Ceiling on computed backoff — and on the Retry-After we are willing to honour. */
export const INFRA_RETRY_MAX_WAIT_MS = 120_000;

/** Consecutive `provider_unavailable` failures that open the run's breaker. */
export const INFRA_RETRY_BREAKER_THRESHOLD = 5;

/** Least clock a retry must still have AFTER its wait: max(60s, 25% of the unit budget). */
export function minimumRetryHeadroomMs(unitTimeoutMs: number): number {
  return Math.max(60_000, Math.ceil(unitTimeoutMs * 0.25));
}

const ON_VALUES = new Set(["1", "true", "on", "yes"]);

/** `MCPJAM_EVAL_INFRA_RETRY` — off by default. */
export function infraRetryEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return ON_VALUES.has(
    (env.MCPJAM_EVAL_INFRA_RETRY ?? "").trim().toLowerCase(),
  );
}

/**
 * `MCPJAM_EVAL_INFRA_RETRY_HARNESS` — reserved for the harness follow-up. v1
 * NEVER retries a harness run: native execution is conservatively effectful
 * from handover unless every dispatch is covered, and attempt-scoped sandbox
 * identity alone does not make a harness turn replay-safe.
 */
export function infraRetryHarnessEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return ON_VALUES.has(
    (env.MCPJAM_EVAL_INFRA_RETRY_HARNESS ?? "").trim().toLowerCase(),
  );
}

/**
 * `MCPJAM_EVAL_MAX_CONCURRENT_CASES`: how many cases of one run execute at
 * once. Default 8, clamped to 1–64; parsed like the render-check cap.
 */
export function resolveMaxConcurrentCases(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number(env.MCPJAM_EVAL_MAX_CONCURRENT_CASES);
  if (!Number.isFinite(raw) || !Number.isInteger(raw)) return 8;
  return Math.min(64, Math.max(1, raw));
}

/** One retried attempt, as recorded on the iteration (diagnostic history). */
export type InfraRetryEntry = {
  /** The attempt that FAILED (1-based). */
  attempt: number;
  attemptId: string;
  class: EvalInfraErrorClass;
  code?: string;
  httpStatus?: number;
  /** How long the runner waited before the next attempt. */
  delayMs: number;
  /** Tokens the failed attempt consumed — still billed, still counted in cost. */
  tokensUsed?: number;
  at: number;
};

/**
 * The RUN's retry budget: at most max(3, 25% of its iterations), and a
 * circuit breaker after {@link INFRA_RETRY_BREAKER_THRESHOLD} consecutive
 * `provider_unavailable` failures — a provider that is down stays down, and
 * hammering it inflates nothing but the bill.
 */
export type RunInfraRetryBudget = {
  readonly max: number;
  used: number;
  consecutiveUnavailable: number;
};

export function createRunInfraRetryBudget(
  totalIterations: number,
): RunInfraRetryBudget {
  return {
    max: Math.max(3, Math.ceil(Math.max(0, totalIterations) * 0.25)),
    used: 0,
    consecutiveUnavailable: 0,
  };
}

/** Feed every attempt's outcome to the breaker. */
export function noteAttemptOutcome(
  budget: RunInfraRetryBudget | undefined,
  outcome: { infraClass?: EvalInfraErrorClass },
): void {
  if (!budget) return;
  budget.consecutiveUnavailable =
    outcome.infraClass === "provider_unavailable"
      ? budget.consecutiveUnavailable + 1
      : 0;
}

export function breakerOpen(budget: RunInfraRetryBudget | undefined): boolean {
  return (
    !!budget && budget.consecutiveUnavailable >= INFRA_RETRY_BREAKER_THRESHOLD
  );
}

/**
 * The wait before retry number `retryIndex` (0-based).
 *
 * A Retry-After the failure carried is honoured EXACTLY — never shortened —
 * and a retry it cannot fit is declined instead. Otherwise: 5s then 20s for an
 * unavailable provider, 30s then 90s for a rate limit or capacity wall, ±20%
 * jitter, capped at {@link INFRA_RETRY_MAX_WAIT_MS}.
 */
export function computeInfraRetryDelay(args: {
  class: EvalInfraErrorClass;
  retryIndex: number;
  retryAfterMs?: number;
  random?: () => number;
}):
  | { ok: true; delayMs: number; source: "retryAfter" | "backoff" }
  | { ok: false; reason: "retry_after_exceeds_max_wait" } {
  if (typeof args.retryAfterMs === "number" && args.retryAfterMs >= 0) {
    if (args.retryAfterMs > INFRA_RETRY_MAX_WAIT_MS) {
      return { ok: false, reason: "retry_after_exceeds_max_wait" };
    }
    return { ok: true, delayMs: Math.round(args.retryAfterMs), source: "retryAfter" };
  }
  const schedule =
    args.class === "provider_unavailable" ? [5_000, 20_000] : [30_000, 90_000];
  const base = schedule[Math.min(args.retryIndex, schedule.length - 1)]!;
  const random = args.random ?? Math.random;
  const jitter = 1 + (random() * 0.4 - 0.2);
  return {
    ok: true,
    delayMs: Math.min(INFRA_RETRY_MAX_WAIT_MS, Math.round(base * jitter)),
    source: "backoff",
  };
}

export type InfraRetryDeclineReason =
  | "flag_off"
  | "not_suite_run"
  | "harness_run"
  | "class_not_retryable"
  | "attempt_state_missing"
  | "dispatch_marker_failed"
  | "effects_dispatched"
  | "max_retries"
  | "run_aborted"
  | "credits_exhausted"
  | "retry_after_exceeds_max_wait"
  | "insufficient_budget"
  | "run_retry_budget_exhausted"
  | "circuit_open";

/** The replay-safety verdict for the attempt that just failed. */
export type ReplaySafety =
  | { safe: true }
  | {
      safe: false;
      reason:
        | "attempt_state_missing"
        | "dispatch_marker_failed"
        | "effects_dispatched";
    };

export type InfraRetryDecision =
  | { retry: true; delayMs: number; delaySource: "retryAfter" | "backoff" }
  | { retry: false; reason: InfraRetryDeclineReason };

/**
 * Decide whether to retry the attempt that just failed. Every condition must
 * hold; the FIRST failing one is the recorded reason, ordered so the reason is
 * the most fundamental one (a harness run is declined as `harness_run` even
 * when it is also out of budget).
 *
 * Does NOT mutate the run budget — {@link commitInfraRetry} does, once the
 * caller actually retries.
 */
export function decideInfraRetry(input: {
  enabled: boolean;
  suiteRunWithRecorder: boolean;
  harness: boolean;
  classified: EvalInfraError & { retryAfterMs?: number };
  replay: ReplaySafety;
  /** Retries already taken for THIS trial. */
  retriesSoFar: number;
  aborted: boolean;
  creditsExhausted: boolean;
  now: number;
  deadlineAt: number;
  unitTimeoutMs: number;
  runBudget: RunInfraRetryBudget | undefined;
  random?: () => number;
}): InfraRetryDecision {
  const decline = (reason: InfraRetryDeclineReason): InfraRetryDecision => ({
    retry: false,
    reason,
  });
  if (!input.enabled) return decline("flag_off");
  if (!input.suiteRunWithRecorder) return decline("not_suite_run");
  if (input.harness) return decline("harness_run");
  if (!INFRA_RETRYABLE_CLASSES.has(input.classified.class)) {
    return decline("class_not_retryable");
  }
  if (!input.replay.safe) return decline(input.replay.reason);
  if (input.retriesSoFar >= INFRA_RETRY_MAX_RETRIES) {
    return decline("max_retries");
  }
  if (input.aborted) return decline("run_aborted");
  if (input.creditsExhausted) return decline("credits_exhausted");
  if (breakerOpen(input.runBudget)) return decline("circuit_open");
  if (input.runBudget && input.runBudget.used >= input.runBudget.max) {
    return decline("run_retry_budget_exhausted");
  }
  const delay = computeInfraRetryDelay({
    class: input.classified.class,
    retryIndex: input.retriesSoFar,
    ...(input.classified.retryAfterMs !== undefined
      ? { retryAfterMs: input.classified.retryAfterMs }
      : {}),
    ...(input.random ? { random: input.random } : {}),
  });
  if (!delay.ok) return decline(delay.reason);
  const remainingAfterWait = input.deadlineAt - (input.now + delay.delayMs);
  if (remainingAfterWait < minimumRetryHeadroomMs(input.unitTimeoutMs)) {
    return decline("insufficient_budget");
  }
  return { retry: true, delayMs: delay.delayMs, delaySource: delay.source };
}

/** Spend one unit of the run budget for a retry the caller is taking. */
export function commitInfraRetry(budget: RunInfraRetryBudget | undefined): void {
  if (budget) budget.used += 1;
}

/**
 * What a runner hands back INSTEAD of finalizing, when it decided to retry:
 * the row stays `running` under the same iteration id, and the loop in
 * `runSingleIteration` waits and runs the next attempt.
 */
export type InfraRetryRequest = {
  delayMs: number;
  entry: InfraRetryEntry;
  /** The failed attempt's usage, carried into the final row's cost. */
  usage: UsageTotals;
};

/** Attempt identity + history the retry loop threads into each attempt. */
export type TrialAttemptContext = {
  /** 1-based. */
  attempt: number;
  attemptId: string;
  /** Usage of earlier, failed attempts — added to the final row's cost. */
  priorUsage?: UsageTotals;
  /** Entries for earlier, failed attempts. */
  infraRetries: InfraRetryEntry[];
  /**
   * The row the FIRST attempt created or claimed. Every later attempt runs on
   * this same row — a retried trial is one trial, never a second row.
   */
  iterationId?: string;
};
