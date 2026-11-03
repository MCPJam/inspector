/**
 * A server that does not answer in time has not broken a rule; it has left
 * the rule untested.
 *
 * A client-backed protocol check used to treat a timeout like any other
 * thrown error: the check failed, and the run marked the session unhealthy,
 * so every check after it reported that it could not run. One slow `tools/list`
 * read as a failure plus a wall of skips, with nothing saying time was the
 * cause. A timed-out check is now `could-not-run` with a marker the report
 * reads, and the checks after it still get their turn.
 */

/**
 * Set to `true` in a check's `details` when a timeout is why it could not run
 * — the marker a report reads to name the timeout instead of a failure.
 */
export const CHECK_TIMED_OUT_DETAIL = "timedOut";

/**
 * The `SdkErrorCode.RequestTimeout` value the upstream client raises. Matched
 * by its string value, like `ERA_NEGOTIATION_FAILED`, so recognition needs no
 * runtime enum import.
 */
const REQUEST_TIMEOUT_CODE = "REQUEST_TIMEOUT";

/** A request that ran out of time: the MCP client's own, or an aborted fetch. */
export function isRequestTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, name } = error as { code?: unknown; name?: unknown };
  return code === REQUEST_TIMEOUT_CODE || name === "TimeoutError";
}

export function checkTimedOutMessage(timeoutMs: number): string {
  return `The server did not answer within ${formatSeconds(timeoutMs)}, so this check could not run. If the server is slow to respond, run the checks again.`;
}

/** `details` carrying the timeout marker and the limit the check ran under. */
export function checkTimedOutDetails(
  timeoutMs: number
): Record<string, unknown> {
  return { [CHECK_TIMED_OUT_DETAIL]: true, timeoutMs };
}

/** A check result that could not run because the server did not answer in time. */
export function isTimedOutCheck(check: { details?: unknown }): boolean {
  const details = check.details as Record<string, unknown> | undefined;
  return details?.[CHECK_TIMED_OUT_DETAIL] === true;
}

function formatSeconds(ms: number): string {
  const seconds = Math.round(ms / 100) / 10;
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

/**
 * Settle with `onTimeout()` if `run` has not settled within `timeoutMs`. The
 * abandoned run keeps going until its own requests time out; the race still
 * holds its rejection handler, so a late rejection is never unhandled.
 */
export async function withDeadline<T>(
  run: Promise<T>,
  timeoutMs: number,
  onTimeout: () => T
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), timeoutMs);
  });
  try {
    return await Promise.race([run, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
