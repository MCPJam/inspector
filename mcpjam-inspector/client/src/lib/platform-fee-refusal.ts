/**
 * A run refused because the organization's credits cannot pay its per-prompt
 * platform fee. The customer brings their own model key, so the only fixes are
 * buying credits or turning on auto-reload; a provider key never helps, and
 * the iteration cap (`billing_limit_reached`) is a different refusal.
 */
export const PLATFORM_FEE_REQUIRED = "PLATFORM_FEE_REQUIRED";

/** The run's `stopReason` when the backend ended it over the fee. */
export const PLATFORM_FEE_STOP_REASON = "platform_fee_required";

export const PLATFORM_FEE_HEADLINE =
  "Your organization's credits can't pay for this run.";

/**
 * Stored rows can carry the code inside a raw error envelope, or only the
 * backend's own sentence (the SDK records the refusal's message).
 */
const FEE_TEXT = /\bPLATFORM_FEE_REQUIRED\b|\brequires platform credits\b/i;

function fieldsOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Whether a launch failure is the fee refusal: the eval route's
 * `details.reason` (carried onto the thrown Error as `reason`), a
 * ConvexError's `data.code`, or the SDK's `EvalBillingError.code`.
 */
export function isPlatformFeeRefusal(error: unknown): boolean {
  const fields = fieldsOf(error);
  return [
    fields.reason,
    fields.code,
    fieldsOf(fields.details).reason,
    fieldsOf(fields.data).code,
  ].includes(PLATFORM_FEE_REQUIRED);
}

/** Whether any stored error text names the fee refusal. */
export function textNamesPlatformFee(
  ...texts: Array<string | null | undefined>
): boolean {
  return texts.some((text) => Boolean(text) && FEE_TEXT.test(text ?? ""));
}

/** The sentence for surfaces that can only show text, such as a toast. */
export function platformFeeRefusalSentence(canManageBilling: boolean): string {
  return canManageBilling
    ? `${PLATFORM_FEE_HEADLINE} Buy credits or turn on auto-reload, then run it again.`
    : `${PLATFORM_FEE_HEADLINE} Ask an owner or admin to buy credits, then run it again.`;
}
