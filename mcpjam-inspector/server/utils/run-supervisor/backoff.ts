/**
 * The pure timing arithmetic behind both retry loops, in a module with no
 * imports of its own.
 *
 * `withRetry` needs to classify errors and therefore reaches the turn-failure
 * predicate; `withCapacityRetry` needs none of that — it works in result shapes
 * its caller defines. Keeping the shared arithmetic here is what lets the
 * control-plane client import the capacity loop without pulling the classifier
 * (and the import cycle behind it) along with it.
 */

/** Maps a computed delay to a jittered one. */
export type Jitter = (delayMs: number) => number;

/**
 * Spread retries that would otherwise collide: `× uniform(0.5, 1.0)`.
 *
 * The same shape `swarm-sandbox.ts` has always used, so several targets that
 * hit capacity together do not retry in lockstep and keep colliding.
 */
export const defaultJitter: Jitter = (delayMs) =>
  delayMs * (0.5 + Math.random() * 0.5);

/** No spreading at all — one interactive caller has no herd to spread. */
export const noJitter: Jitter = (delayMs) => delayMs;

/**
 * The wait before attempt N+1 (N is 1-based):
 * `min(maxDelay, base × 2^(attempt-1))`, then jittered, then rounded.
 */
export function backoffDelayMs(
  attempt: number,
  policy: { baseDelayMs: number; maxDelayMs: number; jitter?: Jitter },
): number {
  const exponential = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * 2 ** Math.max(0, attempt - 1),
  );
  return Math.max(0, Math.round((policy.jitter ?? defaultJitter)(exponential)));
}

/** Clamp `value` into `[low, high]`. */
export function clampDelay(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * A sleep that RESOLVES (never rejects) on abort, so the caller's own guard
 * decides what an abort means rather than an exception deciding for it.
 */
export function abortableSleep(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted || ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}
