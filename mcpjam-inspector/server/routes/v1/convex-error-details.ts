/** Strip Convex's own framing so it cannot reach a public response body. */
export function cleanConvexMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\[Request ID:[^\]]*\]\s*/g, "")
    .replace(/^Server Error\s*/i, "")
    .replace(/Uncaught (Error|ConvexError):\s*/i, "")
    .split("\n")[0]!
    .trim();
}

/**
 * The actionable fields off a billing ConvexError, forwarded as `details`.
 *
 * `limit` says WHICH cap, `plan` and `upgradePlan` say what would lift it, and
 * `currentValue`/`allowedValue` say by how much. Without them a caller gets
 * "Plan limit reached" and has to guess — and an agent has nothing to tell a
 * human beyond that something is capped.
 *
 * Copied field by field rather than passed through: the payload is the
 * backend's internal error shape, and spreading it would publish whatever it
 * gains next without anyone deciding to.
 */
/**
 * The current value a compare-and-set precondition disagreed with.
 *
 * Forwarded so a 409 is RECOVERABLE without a second round-trip: a caller that
 * sent a stale `expectedConfigId` gets the live one back and can decide whether
 * to re-read and retry. Copied key by key rather than spread, for the same
 * reason as `billingDetails` — the payload is the backend's internal error
 * shape, and spreading it would publish whatever it gains next without anyone
 * deciding to.
 *
 * `currentImpact` is a small object of counts rather than a scalar, and it is
 * forwarded whole: an agent proposal that conflicted on impact needs to know
 * WHICH consumer count moved to describe the edit honestly the second time.
 */
export function preconditionDetails(
  data: Record<string, unknown> | null | undefined
): Record<string, unknown> | undefined {
  const payload = data?.data;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const source = payload as Record<string, unknown>;
  const details: Record<string, unknown> = {};
  for (const key of ["currentConfigId", "currentName", "currentImpact"]) {
    if (source[key] !== undefined) details[key] = source[key];
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

export function billingDetails(
  data: Record<string, unknown> | null | undefined
): Record<string, unknown> | undefined {
  if (!data) return undefined;
  const details: Record<string, unknown> = {};
  for (const key of [
    "limit",
    "gateKey",
    "plan",
    "upgradePlan",
    "currentValue",
    "allowedValue",
    // WHEN the cap lifts — epoch ms of the UTC midnight a daily limit rolls
    // at. Documented on `BILLING_LIMIT_REACHED` in `web/errors.ts` since that
    // code existed, and dropped here the whole time, which left "Plan limit
    // reached" as advice a caller could act on only by guessing. It is also
    // the input the 429 below turns into `Retry-After`, so dropping it cost
    // the header as well as the field.
    "resetsAt",
  ]) {
    if (data[key] !== undefined) details[key] = data[key];
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

/**
 * Ceiling on an advertised wait, in seconds — one day.
 *
 * `Number.isFinite` is not enough on its own. `Number.MAX_VALUE` is finite,
 * and `String(Math.ceil(Number.MAX_VALUE / 1000))` is `1.797...e+305`, which
 * `Headers` accepts and every client parses as `NaN`. That is the failure the
 * junk-metadata guard was written to prevent, arriving through the one input
 * shape it does not reject — so the magnitude is clamped as well as the type.
 *
 * A day is the longest wait worth advertising: past that a `Retry-After` reads
 * as "this endpoint is gone" rather than "come back later", and the caps this
 * serves all roll at UTC midnight anyway.
 */
const MAX_RETRY_AFTER_SECONDS = 86_400;

/** Whole seconds, floored at 1 and capped at a day. Always an integer string. */
export function formatRetryAfterSeconds(deltaMs: number): string {
  const seconds = Math.ceil(deltaMs / 1000);
  if (!Number.isFinite(seconds)) return String(MAX_RETRY_AFTER_SECONDS);
  return String(Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, seconds)));
}

/** Seconds-until, floored at 1 — the `Retry-After` value from an instant. */
export function retryAfterFromResetsAt(
  resetsAt: unknown,
  now: number = Date.now()
): string | undefined {
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) {
    return undefined;
  }
  // A reset already in the past means the window rolled between the backend
  // raising this and us serializing it. Advertise the floor rather than
  // omitting the header: the caller's next attempt will succeed, and "1" says
  // so more usefully than silence.
  return formatRetryAfterSeconds(resetsAt - now);
}

/** Same, from a duration a token bucket measured directly. */
export function retryAfterFromMs(retryAfterMs: unknown): string | undefined {
  if (typeof retryAfterMs !== "number" || !Number.isFinite(retryAfterMs)) {
    return undefined;
  }
  return formatRetryAfterSeconds(retryAfterMs);
}

