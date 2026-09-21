/**
 * Retry as a decision, not an accident.
 *
 * The audit that produced this module found three different retry regimes on
 * the eval and swarm paths and no policy behind any of them: the MCP connect
 * policy (deliberate), the AI SDK's implicit default of 2 (nobody set it), and
 * two hand-rolled capacity loops that had diverged. Nothing classified WHY a
 * call failed, so a 401 and a 503 were retried the same number of times, and a
 * rate limit was retried without ever reading `Retry-After`.
 *
 * Two pieces:
 *
 *   {@link classifyRetry} — compose the classifiers this codebase already has
 *   into one closed verdict. It deliberately does not re-implement any of them:
 *   `isRetryableTransientError` (SDK), `isAbortError`, `isAccountLimit` and
 *   `classifyTurnFailure` each stay the single source of truth for their own
 *   question, and this decides the ORDER they are asked in — which is the part
 *   that was missing and the part that is load-bearing. A 429 is transient by
 *   the SDK's test AND rate-limited by the turn classifier; asking transient
 *   first would retry it blindly instead of waiting out its `Retry-After`.
 *
 *   {@link withRetry} — wraps the SDK's `retryWithPolicy` (which already owns
 *   attempt counting, abort checks and the `shouldRetryError` seam) and adds
 *   the three things it lacks: exponential backoff with jitter, `Retry-After`,
 *   and a TOTAL elapsed budget that also clamps each attempt's own deadline.
 *
 * What is NOT here, on purpose: model calls. A stream must never be replayed by
 * us — a half-emitted assistant turn cannot be un-emitted — so model retries are
 * the AI SDK's `maxRetries`, set explicitly from the resolved `turnRetries`
 * rather than left to its default.
 */
import {
  isNonRetryableMarkedError,
  isRetryableTransientError,
  retryWithPolicy,
  type RetryPolicy,
} from "@mcpjam/sdk";

import { isAbortError } from "../../../shared/abort-errors.js";
import { isAccountLimit } from "../../../shared/swarm-attempt-error.js";
import { classifyTurnFailure } from "../turn-failure-classification.js";
import { abortableSleep, backoffDelayMs, type Jitter } from "./backoff.js";
import {
  deadlineClockOf,
  withDeadline,
  type DeadlineClock,
} from "./deadline.js";

// Re-exported so `withRetry`'s callers need only one import. The definitions
// live in a leaf module that `withCapacityRetry` can share WITHOUT dragging
// this file's classifier — and the model stack behind it — along with them.
export { abortableSleep, backoffDelayMs } from "./backoff.js";

export type RetryClass =
  /** Worth another attempt on its own: 5xx, a dropped socket, a DNS blip. */
  | "transient"
  /** Capacity is shared and transient, but the wait is minutes, not seconds. */
  | "capacity"
  /** Retry ONLY against a known `Retry-After` that fits the budget. */
  | "rate_limited"
  /** Auth, 4xx, content policy, schema, spend caps: identical forever. */
  | "terminal"
  /** Somebody asked us to stop. Never a failure, never retried. */
  | "aborted";

export interface RetryClassification {
  class: RetryClass;
  /** Present only when the failure itself said how long to wait. */
  retryAfterMs?: number;
}

/** Codes a control plane uses to say "full, try later" rather than "no". */
const CAPACITY_CODES = new Set(["at_capacity", "sandbox_at_capacity"]);

/**
 * Thrown when the total budget is gone before an attempt could start.
 *
 * Its own type, not a bare `Error`, because {@link classifyRetry} has to
 * recognise it: the natural message ("retry budget ... exhausted") contains the
 * word `budget`, which `classifyTurnFailure` reads as spend-cap wording and
 * would classify `rate_limited`. It terminates either way today, but on an
 * accident rather than a decision — the exact failure mode this module exists
 * to end.
 */
export class RetryBudgetExhaustedError extends Error {
  override readonly name = "RetryBudgetExhaustedError";
  readonly attempts: number;
  readonly totalBudgetMs: number;

  constructor(attempts: number, totalBudgetMs: number) {
    super(
      `retry budget of ${totalBudgetMs}ms exhausted after ${attempts} attempt(s)`,
    );
    this.attempts = attempts;
    this.totalBudgetMs = totalBudgetMs;
  }
}

function errorRecord(error: unknown): Record<string, unknown> | undefined {
  return error && typeof error === "object"
    ? (error as Record<string, unknown>)
    : undefined;
}

function httpStatusOf(error: unknown): number | undefined {
  const record = errorRecord(error);
  if (!record) return undefined;
  for (const key of ["status", "statusCode"]) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  const response = record.response;
  if (response && typeof response === "object") {
    const status = (response as { status?: unknown }).status;
    if (typeof status === "number" && Number.isFinite(status)) return status;
  }
  return undefined;
}

/**
 * Hand the SDK's classifier a status it can actually see.
 *
 * `isRetryableTransientError` extracts an HTTP status from `statusCode` or a
 * NUMERIC `code` — never from `status` or `response.status`, which are exactly
 * the shapes `fetch` responses and this codebase's own `ControlPlaneResult`
 * failures use. Restating its 408/425/429/501/5xx table here would be two
 * copies of one decision, which is the failure mode this module exists to end;
 * so instead the status moves into the field it reads.
 *
 * A COPY, never a mutation — the caller keeps its own object. The caller must
 * therefore have ruled out an identity-marked non-retryable error first: that
 * marking is a WeakSet keyed on the object, and a copy would escape it.
 */
function withStatusCodeForSdk(error: unknown, status: number): unknown {
  const record = errorRecord(error);
  if (record && typeof record.statusCode === "number") return error;
  if (error instanceof Error) {
    const shim = new Error(error.message);
    shim.name = error.name;
    if (error.cause !== undefined) shim.cause = error.cause;
    return Object.assign(shim, record ?? {}, { statusCode: status });
  }
  if (record) return { ...record, statusCode: status };
  return error;
}

function codeOf(error: unknown): string | undefined {
  const record = errorRecord(error);
  const code = record?.code;
  return typeof code === "string" ? code : undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  const record = errorRecord(error);
  const message = record?.error ?? record?.message;
  return typeof message === "string" ? message : "";
}

/**
 * How long the failure asked us to wait, in ms, when it said at all.
 *
 * `retryAfterMs` is the shape this codebase already produces (`postJson` turns
 * the HTTP header's SECONDS into ms at the boundary; the swarm agent's JSON
 * envelope carries `retryAfter` in ms). A raw `Retry-After` header carries
 * EITHER form RFC 9110 allows: `delay-seconds`, or an HTTP-date to wait until.
 * Units are the one place getting it wrong turns a 30-second wait into an
 * eight-hour one, so each form is read on its own terms and anything that is
 * neither returns `undefined` rather than a guess.
 */
export function retryAfterMsOf(
  error: unknown,
  now: () => number = Date.now,
): number | undefined {
  const record = errorRecord(error);
  if (!record) return undefined;
  for (const key of ["retryAfterMs", "retryAfter"]) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return Math.round(value);
    }
  }
  const headers = (record.response as { headers?: unknown } | undefined)
    ?.headers;
  const header =
    headers && typeof (headers as Headers).get === "function"
      ? (headers as Headers).get("retry-after")
      : undefined;
  // MCPClientManager preserves the wire header in SdkHttpError.data before
  // the transport discards it. Unlike normalized top-level values, this is
  // a string in seconds or HTTP-date format, not milliseconds.
  const sdkRetryAfter = errorRecord(record.data)?.retryAfter;
  const raw =
    header ?? (typeof sdkRetryAfter === "string" ? sdkRetryAfter : undefined);
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    // Numeric but negative is a malformed header, not a date: answering
    // `undefined` is right, and falling through would let `Date.parse` read
    // something like "-5" as a year.
    return seconds >= 0 ? Math.round(seconds * 1_000) : undefined;
  }
  const retryAt = Date.parse(raw);
  if (!Number.isFinite(retryAt)) return undefined;
  const delayMs = retryAt - now();
  return delayMs > 0 ? Math.round(delayMs) : undefined;
}

/**
 * Classify a failure into exactly one retry class.
 *
 * ORDER IS THE CONTRACT — every arm below overlaps the ones after it:
 *
 *  1. `aborted` first. An abort's message often contains "timed out", which
 *     the transient matcher reads as retryable; retrying a cancelled run is
 *     the worst outcome in the set.
 *  2. Account limits before rate limits. An org spend cap and a provider
 *     throttle are both "429-shaped" and need opposite handling: waiting does
 *     not refill a wallet, so a spend cap is `terminal`.
 *  3. Capacity before transient. A 503 satisfies the SDK's transient test, but
 *     capacity waits in minutes against a shared pool; treating it as an
 *     ordinary 5xx retries it far too fast and makes the queue worse.
 *  4. Rate limits before transient, so 429 waits out its `Retry-After` instead
 *     of taking the generic backoff. PROSE is consulted only when there is no
 *     status at all: `classifyTurnFailure` exists for the local-BYOK path,
 *     which "attaches no code or status, so prose is all that survives", and
 *     letting it outrank a status the failure DID carry reads a 500 that
 *     mentions a rate limit as `rate_limited` (so it is never retried at all,
 *     absent a `Retry-After`) and a 403 with the same words as retryable.
 *  5. Everything the SDK calls transient — asked with the status moved into the
 *     field its own extractor reads, so a `fetch`-shaped or control-plane-shaped
 *     5xx is not silently dropped into `terminal`.
 *  6. `terminal` — the default, so an unrecognised failure is never retried.
 */
export function classifyRetry(error: unknown): RetryClassification {
  if (isAbortError(error)) return { class: "aborted" };
  if (error instanceof RetryBudgetExhaustedError) return { class: "terminal" };
  // Asked on the ORIGINAL object, before anything below can reshape it: the
  // SDK marks its deliberate final verdicts in a WeakSet keyed on identity.
  if (isNonRetryableMarkedError(error)) return { class: "terminal" };

  const retryAfterMs = retryAfterMsOf(error);
  const withWait = (cls: RetryClass): RetryClassification =>
    retryAfterMs === undefined ? { class: cls } : { class: cls, retryAfterMs };

  const code = codeOf(error);
  const message = messageOf(error);

  if (isAccountLimit(message, code)) return { class: "terminal" };

  const status = httpStatusOf(error);
  if (status === 503 && code !== undefined && CAPACITY_CODES.has(code)) {
    return withWait("capacity");
  }

  if (
    status === 429 ||
    (status === undefined && classifyTurnFailure(message) === "rate_limited")
  ) {
    return withWait("rate_limited");
  }

  const forSdk =
    status === undefined ? error : withStatusCodeForSdk(error, status);
  if (isRetryableTransientError(forSdk)) return withWait("transient");

  return { class: "terminal" };
}

export interface WithRetryPolicy {
  /** Total attempts including the first. 1 disables retrying. */
  maxAttempts: number;
  baseDelayMs: number;
  /** Cap on computed backoff; an upstream Retry-After is a minimum wait. */
  maxDelayMs: number;
  /** Wall-clock ceiling over ALL attempts and all the waiting between them. */
  totalBudgetMs: number;
  /**
   * Per-attempt deadline, further clamped to what is left of the total budget.
   * Absent ⇒ the attempt gets whatever the budget has left, which is what stops
   * one hung call from parking the whole retry sequence past its ceiling.
   */
  attemptTimeoutMs?: number;
  /** Clock name for the per-attempt deadline's abort reason. */
  clock?: DeadlineClock;
  /** Maps a computed delay to a jittered one. Default: × uniform(0.5, 1.0). */
  jitter?: Jitter;
  /** Injectable for tests; production leaves both alone. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  /** Caller-level cancel. Aborts between attempts and during a wait. */
  signal?: AbortSignal;
  /**
   * Called before each wait. Summing `delayMs` across the calls gives the
   * `waitedMs` an iteration records (§10) — the cheap half of the working-time
   * budget a later version can offer.
   */
  onRetry?: (info: {
    attempt: number;
    delayMs: number;
    classification: RetryClassification;
    error: unknown;
  }) => void;
}

/**
 * Run `op` until it succeeds, its class says stop, or the budget runs out.
 *
 * `op` receives its attempt number (1-based) and a signal that is the caller's
 * signal composed with this attempt's own deadline. It should pass that signal
 * down rather than the caller's, so an attempt that hangs is cut loose while
 * the sequence keeps its remaining budget.
 *
 * Throws: the last error on exhaustion, the classifying error immediately on
 * `terminal`, and the abort error on `aborted`. Exception-based on purpose —
 * unlike {@link import("./capacity-retry.js").withCapacityRetry}, whose two
 * callers both work in never-throwing result shapes.
 */
export async function withRetry<T>(
  op: (attempt: number, signal: AbortSignal) => Promise<T>,
  policy: WithRetryPolicy,
): Promise<T> {
  const now = policy.now ?? Date.now;
  const sleep = policy.sleep ?? abortableSleep;
  const deadline = now() + Math.max(0, policy.totalBudgetMs);
  const maxAttempts = Math.max(1, policy.maxAttempts);
  const clock = policy.clock ?? "toolCall";

  const sdkPolicy: RetryPolicy = {
    retries: maxAttempts - 1,
    // All waiting happens in `onRetry` below, where the delay depends on the
    // error that was just classified. The SDK's flat delay would be a second,
    // uncontrolled wait on top of it.
    retryDelayMs: 0,
  };

  // The delay is decided ONCE, in `shouldRetryError`, and read back in
  // `onRetry`. Jitter is random: computing it in both places would check the
  // budget against one number and then sleep a different one.
  let pending:
    | { classification: RetryClassification; delayMs: number }
    | undefined;

  return retryWithPolicy<T>({
    policy: sdkPolicy,
    ...(policy.signal ? { signal: policy.signal } : {}),
    operation: async (zeroBasedAttempt) => {
      const attempt = zeroBasedAttempt + 1;
      const remainingMs = deadline - now();
      if (remainingMs <= 0) {
        throw new RetryBudgetExhaustedError(
          zeroBasedAttempt,
          policy.totalBudgetMs,
        );
      }
      // Clamped rather than allowed to overrun: a caller that asked for a
      // longer per-attempt timeout than the budget still gets one full attempt,
      // and the budget bounds the retries rather than truncating the request
      // the caller configured — the `chat-ingestion.ts` rule.
      const attemptBudgetMs = Math.min(
        policy.attemptTimeoutMs ?? remainingMs,
        remainingMs,
      );
      const handle = withDeadline(policy.signal, attemptBudgetMs, clock, {
        now,
      });
      try {
        return await op(attempt, handle.signal);
      } finally {
        handle.dispose();
      }
    },
    shouldRetryError: (error, zeroBasedAttempt) => {
      pending = undefined;
      const classification = attemptExpired(error, policy, clock)
        ? // THIS attempt ran out of time — which is the whole reason it had a
          // deadline of its own. Left as `aborted` it would end the sequence on
          // the first slow call, so a per-attempt timeout inside a retry loop
          // would mean "one try, then give up": the opposite of its purpose.
          // A caller-level cancel is a different thing entirely and still stops
          // everything, which is what `attemptExpired` checks.
          ({ class: "transient" } as RetryClassification)
        : classifyRetry(error);
      if (
        classification.class === "aborted" ||
        classification.class === "terminal"
      ) {
        return false;
      }

      const attempt = zeroBasedAttempt + 1;
      const delayMs = nextDelayMs(attempt, classification, policy);
      if (delayMs === undefined) return false;
      // Only retry if the WAIT still leaves time to attempt anything after it.
      // Sleeping right up to the deadline and then failing the guard in
      // `operation` spends the whole budget proving nothing.
      if (now() + delayMs >= deadline) return false;
      pending = { classification, delayMs };
      return true;
    },
    onRetry: async ({ attempt: zeroBasedAttempt, error }) => {
      const attempt = zeroBasedAttempt + 1;
      // `shouldRetryError` runs immediately before this and returns true only
      // after setting `pending`; the fallback is defence against a future SDK
      // change to that ordering, not a live path.
      const decided = pending ?? {
        classification: classifyRetry(error),
        delayMs: backoffDelayMs(attempt, policy),
      };
      pending = undefined;
      policy.onRetry?.({
        attempt,
        delayMs: decided.delayMs,
        classification: decided.classification,
        error,
      });
      await sleep(decided.delayMs, policy.signal);
    },
  });
}

/**
 * True when this error is THIS loop's own per-attempt deadline firing, rather
 * than the caller asking to stop.
 *
 * The caller's signal is checked first and decides: when it has aborted, every
 * abort below it is that cancellation, whatever clock happens to be on the
 * reason — a composed signal carries the reason of whichever source fired.
 */
function attemptExpired(
  error: unknown,
  policy: WithRetryPolicy,
  clock: DeadlineClock,
): boolean {
  if (policy.signal?.aborted) return false;
  return deadlineClockOf(error) === clock;
}

/**
 * The wait before attempt N+1, or `undefined` when this class must not be
 * retried at all.
 *
 * A rate limit is retried ONLY against a `Retry-After` the failure actually
 * carried: without one we do not know whether the window is seconds or hours,
 * and guessing is how a retry loop turns a throttle into a ban.
 */
function nextDelayMs(
  attempt: number,
  classification: RetryClassification,
  policy: WithRetryPolicy,
): number | undefined {
  if (classification.retryAfterMs !== undefined) {
    // Never shorten the server's minimum wait to our backoff cap. The total
    // budget check declines the retry if that wait leaves no time for work.
    return Math.max(classification.retryAfterMs, policy.baseDelayMs);
  }
  if (classification.class === "rate_limited") return undefined;
  return backoffDelayMs(attempt, policy);
}

/**
 * Control-plane writes: claim, report, heartbeat.
 *
 * These are small, idempotent and on the critical path of a unit reaching a
 * terminal state, so the budget is short and the attempts few — a claim that
 * cannot land in fifteen seconds is better surfaced than waited on.
 */
export const CONTROL_PLANE_WRITE_RETRY_POLICY = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 5_000,
  totalBudgetMs: 15_000,
} as const satisfies Pick<
  WithRetryPolicy,
  "maxAttempts" | "baseDelayMs" | "maxDelayMs" | "totalBudgetMs"
>;
