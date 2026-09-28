/**
 * Waiting out a full sandbox pool, once, for every caller that has to.
 *
 * Three loops want this and NO TWO OF THEM ARE THE SAME:
 *
 *   Playground   (`control-plane-client.ts`)  retry only `503 && at_capacity`;
 *                unbounded attempts inside a 10-minute deadline; no jitter;
 *                delay `max(30s, Retry-After)` doubling to 5 min; 30s an attempt.
 *   Swarm        (`swarm-sandbox.ts`)         retry `503 || status 0`; EXACTLY
 *                five attempts; no total budget; jittered `4s·2^(n-1)` capped
 *                45s; 30s an attempt.
 *   Eval sandbox (PR 2, new)                  retry `503 && at_capacity`;
 *                `totalBudgetMs = min(5 min, remaining unit budget)`; base 15s,
 *                max 2 min.
 *
 * So this module is deliberately a SHAPE, not a policy. Everything that differs
 * — what counts as retryable, whether attempts or wall-clock bounds the loop,
 * whether delays are jittered, where `Retry-After` comes from — is a field on
 * the policy, and each caller's own tests pin its own numbers. Collapsing them
 * into one "capacity policy" would quietly change two shipped behaviours: the
 * Playground would gain jitter, or the swarm would gain a wall-clock budget it
 * never had, and neither change would show up as a failing test.
 *
 * RESULT-BASED, never exception-based. Both existing callers work in
 * never-throwing result shapes (`ControlPlaneResult`, `ProvisionAttemptResult`)
 * because "the control plane is full" is an answer, not a crash — and because a
 * thrown capacity error is indistinguishable from the sandbox code itself being
 * broken. {@link import("./retry.js").withRetry} is the exception-based
 * counterpart for everything else.
 *
 * Exhaustion returns a REASON rather than a synthesized failure: the two
 * existing callers each answer differently, and the Playground answers two
 * different ways depending on which guard stopped it (a loop-head budget check
 * carries no `Retry-After`; giving up in front of a planned wait carries the
 * wait it was about to take). Inventing one terminal shape here would have
 * silently changed both.
 */
import {
  abortableSleep,
  backoffDelayMs,
  defaultJitter,
  noJitter,
  type Jitter,
} from "./backoff.js";
import { withDeadline, type DeadlineClock } from "./deadline.js";

export interface CapacityRetryPolicy<R> {
  /** True when this result is "full, try again", not a real answer. */
  shouldRetry: (result: R, attempt: number) => boolean;
  /** Absent ⇒ unbounded attempts, bounded only by `totalBudgetMs`. */
  maxAttempts?: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Absent ⇒ no wall-clock bound; `maxAttempts` must then be set. */
  totalBudgetMs?: number;
  /** Floor under every wait, including a `Retry-After` the server sent. */
  minDelayMs?: number;
  /** Per-attempt deadline, further clamped to the remaining total budget. */
  attemptTimeoutMs?: number;
  /** Clock name on the per-attempt deadline's abort reason. */
  clock?: DeadlineClock;
  /** How to read a server-sent wait off a retryable result. */
  retryAfterMsOf?: (result: R) => number | undefined;
  /** Maps a computed delay to a jittered one. Default: identity (no jitter). */
  jitter?: Jitter;
  /** Injectable for tests; production leaves both alone. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
  /** Called before each wait — the Playground's user-visible "waiting" notice. */
  onWait?: (info: { attempt: number; delayMs: number; result: R }) => void;
}

export type CapacityRetryOutcome<R> =
  /** `op` returned something `shouldRetry` did not claim. Not necessarily ok. */
  | { kind: "settled"; result: R; attempts: number; waitedMs: number }
  | {
      kind: "exhausted";
      reason: CapacityExhaustionReason;
      /** Absent only when the budget died before the first attempt. */
      lastResult?: R;
      /** The wait that was about to be taken, on `budget_before_delay`. */
      plannedDelayMs?: number;
      attempts: number;
      waitedMs: number;
    };

export type CapacityExhaustionReason =
  /** The wall-clock budget was gone at the top of a loop turn. */
  | "budget_exhausted"
  /** The next wait would not fit inside the budget, or the caller aborted. */
  | "budget_before_delay"
  /** `maxAttempts` were spent and the last one was still retryable. */
  | "attempts_exhausted"
  /** The caller's signal aborted between attempts. */
  | "aborted";

/** The numeric half of a policy — what a caller can share as a constant. */
export type CapacityRetryBudget = Pick<
  CapacityRetryPolicy<never>,
  | "maxAttempts"
  | "baseDelayMs"
  | "maxDelayMs"
  | "totalBudgetMs"
  | "minDelayMs"
  | "attemptTimeoutMs"
  | "jitter"
>;

/**
 * Playground desktop capacity (§3.5).
 *
 * No `maxAttempts` and no jitter, both on purpose: one interactive user is
 * waiting on a spinner, so there is no thundering herd to spread out, and the
 * ten-minute wall clock — not a try count — is what the ceiling means. The 30s
 * floor under every wait (including a server-sent `Retry-After`) keeps a full
 * pool from being re-polled on the second.
 *
 * `totalBudgetMs` is the DEFAULT; `provisionPlaygroundSandbox` lets a caller
 * pass a shorter one.
 */
export const PLAYGROUND_CAPACITY_POLICY = {
  baseDelayMs: 30_000,
  maxDelayMs: 5 * 60_000,
  minDelayMs: 30_000,
  totalBudgetMs: 10 * 60_000,
  attemptTimeoutMs: 30_000,
} as const satisfies CapacityRetryBudget;

/**
 * Eval-run sandbox capacity.
 *
 * Deliberately NOT the Playground numbers, and the differences are the whole
 * reason this is a second constant rather than a shared one:
 *
 *   - **Jitter is ON.** A suite launches its iterations together, so a full
 *     pool would otherwise be re-polled by every one of them on the same tick
 *     — the thundering herd the Playground's single waiting user cannot
 *     produce.
 *   - **Two minutes, not ten.** This wait is spent INSIDE the iteration's own
 *     clock (10 minutes by default). A ten-minute capacity wait would eat the
 *     entire iteration and leave nothing for the work it was waiting to do.
 *   - **Attempts are capped.** With a wall clock and jitter both in play, a
 *     try cap is what keeps the worst case legible.
 *
 * The floor stays 15s: a queue that is full is not going to clear in under a
 * second, and re-polling it that fast only adds load to the thing already
 * short of capacity.
 */
export const EVAL_SANDBOX_CAPACITY_POLICY = {
  maxAttempts: 4,
  baseDelayMs: 15_000,
  maxDelayMs: 60_000,
  // Deliberately BELOW the jitter's own floor. `defaultJitter` maps a delay
  // onto [0.5x, 1x], so the first retry's 15s becomes 7.5–15s — and a
  // `minDelayMs` of 15s clamps every one of those back to exactly 15s,
  // undoing the spreading this policy adds jitter for in the first place.
  // What the floor is actually for is a server-sent `Retry-After` of one
  // second against a pool that is not going to clear in one second.
  minDelayMs: 7_500,
  totalBudgetMs: 2 * 60_000,
  attemptTimeoutMs: 30_000,
  jitter: defaultJitter,
} as const satisfies CapacityRetryBudget;

/** Swarm provisioning: preserve the five-attempt, status 503/0 policy. */
export const SWARM_SANDBOX_CAPACITY_POLICY = {
  shouldRetry: (result: { status: number }) => result.status === 503 || result.status === 0,
  maxAttempts: 5,
  baseDelayMs: 4_000,
  maxDelayMs: 45_000,
  attemptTimeoutMs: 30_000,
  jitter: defaultJitter,
} as const;

/**
 * Call `op` until it settles, the policy stops retrying, or a bound is hit.
 *
 * `op` receives its 1-based attempt number and a signal composed from the
 * caller's signal and this attempt's own deadline — pass THAT down, so a
 * control plane that accepts the connection and then stalls costs one attempt
 * rather than the whole loop.
 */
export async function withCapacityRetry<R>(
  op: (attempt: number, signal: AbortSignal) => Promise<R>,
  policy: CapacityRetryPolicy<R>,
): Promise<CapacityRetryOutcome<R>> {
  const now = policy.now ?? Date.now;
  const sleep = policy.sleep ?? abortableSleep;
  const jitter = policy.jitter ?? noJitter;
  const startedAt = now();
  const hasBudget = typeof policy.totalBudgetMs === "number";
  const deadline = hasBudget
    ? startedAt + Math.max(0, policy.totalBudgetMs as number)
    : Number.POSITIVE_INFINITY;
  const maxAttempts = policy.maxAttempts ?? Number.POSITIVE_INFINITY;
  const clock = policy.clock ?? "sandboxCapacity";

  let attempts = 0;
  let waitedMs = 0;
  let lastResult: R | undefined;

  for (;;) {
    if (policy.signal?.aborted) {
      return exhausted("aborted");
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      return exhausted("budget_exhausted");
    }

    // Bound each ATTEMPT, not only the sleeps — but capped by what is LEFT of
    // the aggregate budget, so a caller that asked for less than the per-attempt
    // timeout (or a last attempt with seconds to spare) still gets the deadline
    // it asked for rather than a flat one on top of it.
    const attemptBudgetMs = Math.min(
      policy.attemptTimeoutMs ?? remainingMs,
      remainingMs,
    );
    const handle = withDeadline(policy.signal, attemptBudgetMs, clock, { now });
    attempts += 1;
    let result: R;
    try {
      result = await op(attempts, handle.signal);
    } finally {
      handle.dispose();
    }
    lastResult = result;

    if (!policy.shouldRetry(result, attempts)) {
      return { kind: "settled", result, attempts, waitedMs };
    }
    if (attempts >= maxAttempts) {
      return exhausted("attempts_exhausted");
    }

    const delayMs = nextDelayMs(result);
    // Both guards in ONE condition, matching the loop this replaces: a caller
    // that aborted in front of a planned wait gets the same answer as one whose
    // budget ran out, because in both cases the wait is what could not happen.
    if (now() + delayMs > deadline || policy.signal?.aborted) {
      return exhausted("budget_before_delay", delayMs);
    }

    policy.onWait?.({ attempt: attempts, delayMs, result });
    await sleep(delayMs, policy.signal);
    waitedMs += delayMs;
  }

  function nextDelayMs(result: R): number {
    const retryAfterMs = policy.retryAfterMsOf?.(result);
    const floor = policy.minDelayMs ?? 0;
    if (retryAfterMs !== undefined) {
      // A server-sent wait overrides the computed backoff, clamped to
      // [floor-or-base, max] so a control plane cannot talk a caller into a
      // wait outside its own policy.
      return Math.round(
        Math.min(
          policy.maxDelayMs,
          Math.max(policy.minDelayMs ?? policy.baseDelayMs, retryAfterMs),
        ),
      );
    }
    return Math.max(
      floor,
      backoffDelayMs(attempts, {
        baseDelayMs: policy.baseDelayMs,
        maxDelayMs: policy.maxDelayMs,
        jitter,
      }),
    );
  }

  function exhausted(
    reason: CapacityExhaustionReason,
    plannedDelayMs?: number,
  ): CapacityRetryOutcome<R> {
    return {
      kind: "exhausted",
      reason,
      ...(lastResult !== undefined ? { lastResult } : {}),
      ...(plannedDelayMs !== undefined ? { plannedDelayMs } : {}),
      attempts,
      waitedMs,
    };
  }
}
