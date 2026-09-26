/**
 * Classify a failed `fetch` without pulling in anything else. Kept dependency-
 * free so any server module can read a network failure's real cause.
 */

/**
 * Detect Node/undici connection-level fetch failures
 * (`TypeError: fetch failed` with a populated `cause`).
 *
 * These happen on the *client's* network — DNS miss, connection refused, TLS
 * failure, etc. — so logging them as warnings to Sentry conflates user-side
 * connectivity with backend issues. Callers should route these to a debug
 * log instead while still surfacing backend HTTP/logical errors as warnings.
 */
export function isFetchConnectionFailure(error: unknown): boolean {
  return error instanceof TypeError && /fetch failed/i.test(error.message);
}

/**
 * Pull the underlying network error code (e.g. `ECONNREFUSED`, `ENOTFOUND`)
 * out of a `fetch failed` TypeError. `error.cause` is where undici stashes
 * the real reason; `error.message` is the useless generic wrapper.
 */
export function getFetchErrorCause(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } })?.cause?.code;
  return typeof cause === "string" ? cause : undefined;
}

/**
 * Did the request's own signal cut this fetch short? `AbortSignal.timeout`
 * rejects with a `TimeoutError`, which `shared/abort-errors.ts#isAbortError`
 * does not match. Follows `cause`, because a body read torn down mid-stream can
 * arrive as `TypeError: terminated` with the abort underneath. Checks by name,
 * not `instanceof`: the rejection is a `DOMException`.
 */
export function isFetchTimeout(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (!current || typeof current !== "object") return false;
    const name = (current as { name?: unknown }).name;
    if (name === "TimeoutError" || name === "AbortError") return true;
    const cause: unknown = (current as { cause?: unknown }).cause;
    if (cause === undefined || cause === current) return false;
    current = cause;
  }
  return false;
}
