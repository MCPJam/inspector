import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";

/**
 * The backend's eval_step fee refusals, raised by `startSuiteRunIterations`
 * when the organization cannot pay for the iterations it is reserving. Status
 * and code mirror the backend's own HTTP answer for the same refusals
 * (`requiredFeeErrorResponse`). `PLATFORM_FEE_UNAVAILABLE` is left out: it is
 * the transient one, and stays on the retryable 500 path.
 */
const PLATFORM_FEE_REFUSALS = new Map<
  string,
  { status: 403 | 429; code: ErrorCode; fallback: string }
>([
  [
    "PLATFORM_FEE_REQUIRED",
    {
      status: 403,
      code: ErrorCode.FORBIDDEN,
      fallback:
        "This work requires platform credits. Add credits or contact your organization administrator.",
    },
  ],
  [
    "ORGANIZATION_SPEND_BUDGET_REACHED",
    {
      status: 429,
      code: ErrorCode.RATE_LIMITED,
      fallback:
        "This organization's spend budget is reached. An owner or admin can raise it in Organization → Budget.",
    },
  ],
]);

/**
 * Translate a fee refusal (a `ConvexError` whose `data.code` is one of the
 * codes above) into the route error the caller can act on. Null for anything
 * else, so a real fault stays a fault.
 */
export function platformFeeRefusalError(error: unknown): WebRouteError | null {
  const data = (error as { data?: unknown } | null)?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const { code, message } = data as { code?: unknown; message?: unknown };
  if (typeof code !== "string") return null;
  const entry = PLATFORM_FEE_REFUSALS.get(code);
  if (!entry) return null;
  return new WebRouteError(
    entry.status,
    entry.code,
    typeof message === "string" && message.trim() ? message : entry.fallback,
    { reason: code },
  );
}
