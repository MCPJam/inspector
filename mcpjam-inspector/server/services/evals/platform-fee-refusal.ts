import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";

/**
 * The backend's eval_step fee refusals, raised by `startSuiteRunIterations`
 * when the organization cannot pay for the iterations it is reserving, keyed
 * to the message used when the backend sends none.
 *
 * Both answer 403. The backend's own fee route sends the spend budget as a
 * 429, but the v1 spec promises `Retry-After` on every 429 and a budget has no
 * retry time: it clears when an admin raises it or the window resets.
 * `PLATFORM_FEE_UNAVAILABLE` is left out: it is the transient one, and stays
 * on the retryable 500 path.
 */
const PLATFORM_FEE_REFUSALS = new Map<string, string>([
  [
    "PLATFORM_FEE_REQUIRED",
    "This work requires platform credits. Add credits or contact your organization administrator.",
  ],
  [
    "ORGANIZATION_SPEND_BUDGET_REACHED",
    "This organization's spend budget is reached. An owner or admin can raise it in Organization → Budget.",
  ],
]);

/**
 * Translate a fee refusal (a `ConvexError` whose `data.code` is one of the
 * codes above) into a 403 naming it in `details.reason`. Null for anything
 * else, so a real fault stays a fault.
 */
export function platformFeeRefusalError(error: unknown): WebRouteError | null {
  const data = (error as { data?: unknown } | null)?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const { code, message } = data as { code?: unknown; message?: unknown };
  if (typeof code !== "string") return null;
  const fallback = PLATFORM_FEE_REFUSALS.get(code);
  if (!fallback) return null;
  return new WebRouteError(
    403,
    ErrorCode.FORBIDDEN,
    typeof message === "string" && message.trim() ? message : fallback,
    { reason: code },
  );
}

/** Whether `error` is a refusal `platformFeeRefusalError` produced. */
export function isPlatformFeeRefusal(error: unknown): error is WebRouteError {
  if (!(error instanceof WebRouteError)) return false;
  const reason = error.details?.reason;
  return typeof reason === "string" && PLATFORM_FEE_REFUSALS.has(reason);
}
