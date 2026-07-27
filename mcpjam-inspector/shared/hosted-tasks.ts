/**
 * Hosted task polling constants, shared by the client poller and the hosted
 * routes' batch schema so the two can never drift.
 */

/**
 * Floor for hosted poll ticks. Every hosted poll is a full
 * authorize → connect → request → disconnect round trip, so a user-configured
 * interval below this would multiply connection cost for no added fidelity.
 * The effective interval is `max(userInterval, HOSTED_TASK_POLL_FLOOR_MS)`,
 * further widened by a server-advertised `pollIntervalMs`.
 */
export const HOSTED_TASK_POLL_FLOOR_MS = 2000;

/** Maximum task IDs per `/get-batch` call (mirrors the route schema). */
export const HOSTED_TASK_BATCH_LIMIT = 50;

/**
 * Server-side task age at which the client stops tracking a handle even if it
 * was never resolved: task IDs are bearer-ish and unbounded growth in
 * localStorage helps nobody.
 */
export const TRACKED_TASK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function hostedPollIntervalMs(
  userIntervalMs: number,
  serverPollIntervalMs?: number,
): number {
  return Math.max(
    userIntervalMs,
    HOSTED_TASK_POLL_FLOOR_MS,
    serverPollIntervalMs ?? 0,
  );
}
