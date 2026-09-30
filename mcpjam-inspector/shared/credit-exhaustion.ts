import {
  isHeldCreditsRefusal,
  withoutHeldCreditsSentence,
} from "./swarm-attempt-error.js";

/** The fields a refusal states itself in; see {@link isHoldRefusal}. */
const OWN_MESSAGE_KEYS = ["message", "error", "errorMessage"] as const;

/**
 * What an exhaustion SAYS, in words. Kept apart from the codes below because
 * the codes also ride a hold (`user_rate_limit` is the generic code for both),
 * so only these phrases can tell a text that also states an exhaustion from a
 * text that is only a hold.
 */
const EXHAUSTION_PHRASES: readonly RegExp[] = [
  /mcpjam[\w\s-]{0,40}model limit/i,
  /\b(?:daily|monthly) (?:MCPJam )?credit limit reached\b/i,
  /\bThis request needs about \d+ MCPJam credits\b/i,
  /\b(?:out of (?:MCPJam )?credits|insufficient credits|credits? (?:balance )?(?:exhausted|depleted)|credit limit (?:was )?(?:reached|exceeded))\b/i,
];

const EXHAUSTION_CODES =
  /\b(?:mcpjam_rate_limit|user_rate_limit|org_rate_limit|billing_limit_reached)\b/i;

/**
 * The exhaustion codes that never ride a hold. A hold answers with the generic
 * `user_rate_limit` (`buildSpendRefusalBody`), so that one says nothing next to
 * the sentence; these three do.
 */
const EXHAUSTION_ONLY_CODES =
  /\b(?:mcpjam_rate_limit|org_rate_limit|billing_limit_reached)\b/i;

/** The held-credits sentence is a hold; what is left of the text may not be. */
const statesExhaustion = (text: string): boolean => {
  const rest = withoutHeldCreditsSentence(text);
  return (
    EXHAUSTION_PHRASES.some((phrase) => phrase.test(rest)) ||
    EXHAUSTION_ONLY_CODES.test(rest)
  );
};

/**
 * The object a refusal states itself in: the value, or the JSON envelope a
 * string wraps (error envelopes often prefix a JSON response with a URL and
 * status).
 */
const refusalRoot = (value: unknown): Record<string, unknown> | undefined => {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  if (typeof value !== "string") return undefined;
  const start = value.indexOf("{");
  if (start < 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(value.slice(start));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Is this refusal a hold (other in-flight requests hold the last credits) and
 * nothing more? Then it is a wait, not an empty wallet.
 *
 * - A structured `refusalReason` decides alone. The backend said what it was;
 *   its own prose cannot outvote it.
 * - Without one (a stored attempt row keeps the sentence and loses the reason)
 *   the refusal's OWN words decide: the top-level message fields, and the
 *   top-level `details` when it is a string. A sentence quoted deeper (a value
 *   under `details`, a nested object's own `message`, a history entry) is
 *   someone else's words and never counts. So does its own `code`: a hold rides
 *   `user_rate_limit`, and any other code is a different refusal.
 * - A text that states the hold AND an exhaustion (one string aggregating
 *   several session errors) is an exhaustion: the hold must not hide it.
 *
 * Exported so a surface that words a refusal (the agent panel, the generation
 * workspace) reads it the same way the dialog does; two readings of one
 * refusal would print "try again in a few seconds" under an open upgrade dialog.
 */
export const isHoldRefusal = (value: unknown, depth = 0): boolean => {
  if (depth > 3) return false;
  const root = refusalRoot(value);
  if (root) {
    const reason = root.refusalReason;
    if (typeof reason === "string" && reason)
      return reason === "holds_committed";
    if (
      typeof root.code === "string" &&
      root.code &&
      root.code !== "user_rate_limit"
    )
      return false;
    const texts = [...OWN_MESSAGE_KEYS.map((key) => root[key]), root.details];
    const own = texts.filter(
      (text): text is string => typeof text === "string",
    );
    return (
      own.some((text) => isHoldRefusal(text, depth + 1)) &&
      !own.some(statesExhaustion)
    );
  }
  return (
    typeof value === "string" &&
    isHeldCreditsRefusal(null, null, value) &&
    !statesExhaustion(value)
  );
};

/** Account credit exhaustion, shared by notifications and run schedulers.
 * Provider 429s and admin spend caps must never be treated as a top-up signal.
 */
export function isCreditExhaustion(value: unknown): boolean {
  if (isHoldRefusal(value)) return false;
  const seen = new WeakSet<object>();
  const strings = new Set<string>();
  let exhausted = false;
  let excluded = false;
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      if (strings.has(item)) return;
      strings.add(item);
      if (
        // `platform_capacity`, `agent_turn_limit` and `agent_billing_rejected`
        // are Ask MCPJam's refusals: MCPJam's own budget, a per-user COUNT,
        // and a billing claim that did not hold. Like the others here, none is
        // a wallet anyone can top up — and they arrive on a surface the
        // product calls free, so selling credits against one would be wrong
        // twice over.
        /\b(?:platform_free_budget_exhausted|account_suspended|spend_budget_reached|ORGANIZATION_SPEND_BUDGET_REACHED|wallet_locked|platform_capacity|agent_turn_limit|agent_billing_rejected)\b/i.test(
          item,
        )
      ) {
        excluded = true;
      }
      if (
        EXHAUSTION_CODES.test(item) ||
        EXHAUSTION_PHRASES.some((phrase) => phrase.test(item))
      )
        exhausted = true;
      // Error envelopes often prefix a JSON response with a URL and status.
      const start = item.indexOf("{");
      if (start >= 0) {
        try {
          visit(JSON.parse(item.slice(start)));
        } catch {
          /* Plain text. */
        }
      }
      return;
    }
    if (!item || typeof item !== "object" || seen.has(item)) return;
    seen.add(item);
    // Billing also uses this code for plan quotas (e.g. Eval iteration count).
    // Those have their own upgrade dialog and cannot be lifted by credit.
    for (const key of ["gateKey", "limit"]) {
      const gate = (item as Record<string, unknown>)[key];
      if (
        typeof gate === "string" &&
        /^max[A-Z]/.test(gate) &&
        !/credit/i.test(gate)
      )
        excluded = true;
    }
    if ("limitKind" in item && item.limitKind === "concurrency")
      excluded = true;
    // Other in-flight requests hold the last credits; the backend says retry
    // in seconds. Treating it as exhaustion stopped runs and locked models.
    // The structured reason decides at any depth: a nested refusal can carry
    // it without a code. Its SENTENCE is read only at the top (above).
    if ((item as Record<string, unknown>).refusalReason === "holds_committed")
      excluded = true;
    if (item instanceof Error) visit(item.message);
    for (const nested of Object.values(item)) visit(nested);
  };
  visit(value);
  return exhausted && !excluded;
}
