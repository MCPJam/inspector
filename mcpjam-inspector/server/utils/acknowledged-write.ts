/**
 * "Did this write actually land?" — the one question two very different
 * durable hand-offs both have to answer, and the one rule they share: state is
 * released only on a CONFIRMED acknowledgement, never on the absence of an
 * error.
 *
 * Its two users:
 *
 *   - `browser-artifact-outbox.ts`, whose batches are held in a map and
 *     retried on the next flush. A drain advances its source cursor
 *     irreversibly, so a batch dropped on a transient failure is gone; it is
 *     deleted from the map only when the mutation confirms.
 *   - the harness EVIDENCE client, which cannot flush later at all: a
 *     `tools/call` is blocked on the acknowledgement, because the whole point
 *     is that the record exists before the user's server is contacted.
 *
 * Those differ in WHEN they retry, which is why this module owns only the
 * attempt: run the write, classify what came back, and — where a caller has a
 * budget — spend it. Nothing here queues, batches, or schedules; the callers
 * keep their own shapes, which is what stops this from becoming a third retry
 * queue nobody owns.
 *
 * `retryable` is the distinction that matters and the one an exception cannot
 * express: a body too large will fail identically forever (stop, and let the
 * loss be visible), while a 500 or a dropped socket is worth another attempt.
 * Retrying the first kind spends a settlement budget on a write that cannot
 * succeed — and on the evidence path, that budget is a real agent waiting.
 */

/** What one attempt at a durable write concluded. */
export type WriteAttempt<T> =
  | { status: "acknowledged"; value: T }
  /** Not this time — the same attempt is worth making again. */
  | { status: "retryable"; reason: string }
  /** Never, however many times it is tried. */
  | { status: "permanent"; reason: string };

export type AcknowledgedWriteResult<T> =
  | { acknowledged: true; value: T; attempts: number }
  | { acknowledged: false; reason: string; attempts: number; gaveUp: boolean };

export type AcknowledgedWriteOptions = {
  /**
   * Total attempts, including the first. 1 means "try once and report".
   * A caller blocking an agent on this must count in wall-clock, not tries.
   */
  maxAttempts?: number;
  /** Backoff before attempt N+1, in ms. Called with a 1-based attempt number. */
  delayMsForAttempt?: (attempt: number) => number;
  /** Injectable for tests; production leaves it alone. */
  sleep?: (ms: number) => Promise<void>;
  /** Aborts between attempts — a cancelled turn stops retrying immediately. */
  signal?: AbortSignal;
};

const DEFAULT_MAX_ATTEMPTS = 3;

/** 250ms, 1s — short enough to stay inside a tool call a model is waiting on. */
function defaultDelayMsForAttempt(attempt: number): number {
  return attempt === 1 ? 250 : 1_000;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Attempt a durable write until it is acknowledged, its budget runs out, or it
 * fails permanently. NEVER THROWS — the caller gets a verdict, because on both
 * paths above an exception would be indistinguishable from "the thing this
 * write was protecting also failed".
 */
export async function writeUntilAcknowledged<T>(
  attempt: () => Promise<WriteAttempt<T>>,
  options: AcknowledgedWriteOptions = {},
): Promise<AcknowledgedWriteResult<T>> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const delayFor = options.delayMsForAttempt ?? defaultDelayMsForAttempt;
  const sleep = options.sleep ?? defaultSleep;

  let lastReason = "write was never attempted";

  for (
    let attemptNumber = 1;
    attemptNumber <= maxAttempts;
    attemptNumber += 1
  ) {
    if (options.signal?.aborted) {
      return {
        acknowledged: false,
        reason: "aborted",
        attempts: attemptNumber - 1,
        gaveUp: false,
      };
    }

    let outcome: WriteAttempt<T>;
    try {
      outcome = await attempt();
    } catch (error) {
      // A thrown attempt is retryable by default: the classifications above
      // are things a caller DECIDED, and an exception carries no decision.
      outcome = {
        status: "retryable",
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    if (outcome.status === "acknowledged") {
      return {
        acknowledged: true,
        value: outcome.value,
        attempts: attemptNumber,
      };
    }
    lastReason = outcome.reason;
    if (outcome.status === "permanent") {
      return {
        acknowledged: false,
        reason: outcome.reason,
        attempts: attemptNumber,
        // Not "gave up": there was nothing to give up on. The distinction
        // matters to a caller deciding whether the failure is worth an alert.
        gaveUp: false,
      };
    }

    if (attemptNumber < maxAttempts) {
      const delayMs = delayFor(attemptNumber);
      if (delayMs > 0) await sleep(delayMs);
    }
  }

  return {
    acknowledged: false,
    reason: lastReason,
    attempts: maxAttempts,
    gaveUp: true,
  };
}
