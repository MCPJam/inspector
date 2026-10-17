import { ConvexError } from "convex/values";
import { translatePlatformFeeError } from "../../routes/v1/platform-fee-errors.js";
import { convexErrorData } from "../../routes/v1/convex-error-data.js";
import { ErrorCode, WebRouteError } from "../../routes/web/errors";

/**
 * When a Convex mutation rejects because a billing/entitlement cap was hit
 * (e.g. `maxEvalIterationsPerMonth`), the structured payload lives on
 * `ConvexError.data`. Re-emit it as a 402 `WebRouteError` carrying that exact
 * payload in `details`, so the route serializes it onto the JSON body and the
 * client can rebuild a ConvexError and render the proper upgrade message —
 * instead of collapsing it into a generic 500 where the billing fields are
 * lost. Platform fee refusals keep their own status (402, 426 or 503). Returns
 * null for any non-billing error so callers fall through to their normal
 * handling.
 */
export function asBillingRouteError(error: unknown): WebRouteError | null {
  const fee = translatePlatformFeeError(convexErrorData(error));
  if (fee) return fee;
  if (!(error instanceof ConvexError)) {
    return null;
  }
  const data = error.data as { code?: unknown; message?: unknown } | undefined;
  if (
    !data ||
    typeof data !== "object" ||
    (data.code !== "billing_limit_reached" &&
      data.code !== "billing_feature_not_included")
  ) {
    return null;
  }
  const message =
    typeof data.message === "string" && data.message.length > 0
      ? data.message
      : "Your plan limit was reached.";
  return new WebRouteError(
    402,
    ErrorCode.BILLING_LIMIT_REACHED,
    message,
    data as Record<string, unknown>,
  );
}

export type BillingRefusalReason =
  "billing_limit_reached" | "spend_budget_reached" | "platform_fee_refused";

/**
 * The billing refusal behind a launch failure. A refusal translated by
 * `asBillingRouteError` carries prose in its message and its codes in
 * `details`, so both are read; a raw ConvexError still carries them in the
 * message. Workers use this to pause on billing instead of retrying it.
 */
export function billingRefusalReason(
  error: unknown,
): BillingRefusalReason | null {
  const details =
    error instanceof WebRouteError && error.details ? error.details : {};
  const markers = [
    error instanceof Error ? error.message : String(error),
    details.code,
    details.reason,
  ]
    .filter((marker): marker is string => typeof marker === "string")
    .join(" ");
  if (/billing_limit_reached/i.test(markers)) return "billing_limit_reached";
  if (/spend_budget_reached|ORGANIZATION_SPEND_BUDGET_REACHED/i.test(markers))
    return "spend_budget_reached";
  if (/platform_fee_refused/i.test(markers)) return "platform_fee_refused";
  return null;
}
