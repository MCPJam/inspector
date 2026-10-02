import {
  EXHAUSTION_PHRASES,
  isHeldCreditsRefusal,
  namesAnotherRefusal,
  parseJsonEnvelope,
  statesExhaustion,
} from "./swarm-attempt-error.js";

/** The fields a refusal states itself in; see {@link isHoldRefusal}. */
const OWN_MESSAGE_KEYS = ["message", "error", "errorMessage"] as const;

const EXHAUSTION_CODES =
  /\b(?:mcpjam_rate_limit|user_rate_limit|org_rate_limit|billing_limit_reached)\b/i;

/**
 * The object a refusal states itself in: the value, or the JSON envelope a
 * string wraps (error envelopes often prefix a JSON response with a URL and
 * status).
 */
const refusalRoot = (value: unknown): Record<string, unknown> | undefined => {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return typeof value === "string"
    ? parseJsonEnvelope(value) ?? undefined
    : undefined;
};

/**
 * Does `test` hold of `value`, or of anything under it? Objects are searched
 * through their values, and an error string that wraps a JSON envelope is
 * searched as the object it wraps.
 */
const someNested = (
  value: unknown,
  test: (item: unknown) => boolean,
  depth = 0,
  seen = new WeakSet<object>(),
): boolean => {
  if (depth > 6) return false;
  if (test(value)) return true;
  if (typeof value === "string") {
    const envelope = parseJsonEnvelope(value);
    return envelope ? someNested(envelope, test, depth + 1, seen) : false;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (value instanceof Error)
    return someNested(value.message, test, depth + 1, seen);
  return Object.values(value).some((nested) =>
    someNested(nested, test, depth + 1, seen),
  );
};

/** The structured `refusalReason` a refusal carries, at any depth. */
const findRefusalReason = (root: unknown): string | undefined => {
  let found: string | undefined;
  someNested(root, (item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const reason = (item as Record<string, unknown>).refusalReason;
    if (typeof reason !== "string" || !reason) return false;
    found = reason;
    return true;
  });
  return found;
};

/**
 * Is this refusal a hold (other in-flight requests hold the last credits) and
 * nothing more? Then it is a wait, not an empty wallet.
 *
 * The rules are {@link isHeldCreditsRefusal}'s, read off a refusal's fields:
 *
 * - A `code` that names a different refusal rules a hold out.
 * - A structured `refusalReason` decides alone, at any depth: a nested refusal
 *   can carry it without a code. The backend said what it was; its own prose
 *   cannot outvote it.
 * - Without one (a stored attempt row keeps the sentence and loses the reason)
 *   the refusal's OWN words decide: the top-level message fields, and the
 *   top-level `details` when it is a string. A sentence quoted deeper (a value
 *   under `details`, a nested object's own `message`, a history entry) is
 *   someone else's words and never counts as a hold.
 * - But an exhaustion stated ANYWHERE in the refusal, nested or beside the
 *   sentence, wins: the hold must not hide it (one string aggregating several
 *   session errors, or `details` carrying a limit code).
 *
 * Exported so a surface that words a refusal (the agent panel, the generation
 * workspace) reads it the same way the dialog does; two readings of one
 * refusal would print "try again in a few seconds" under an open upgrade dialog.
 */
export const isHoldRefusal = (value: unknown, depth = 0): boolean => {
  if (depth > 3) return false;
  const root = refusalRoot(value);
  if (root) {
    const code = typeof root.code === "string" ? root.code : undefined;
    if (namesAnotherRefusal(code)) return false;
    const reason = findRefusalReason(root);
    if (reason) return isHeldCreditsRefusal(code, reason);
    const own = [...OWN_MESSAGE_KEYS.map((key) => root[key]), root.details];
    return (
      own.some(
        (text) => typeof text === "string" && isHoldRefusal(text, depth + 1),
      ) &&
      !someNested(
        root,
        (item) => typeof item === "string" && statesExhaustion(item),
      )
    );
  }
  return typeof value === "string" && isHeldCreditsRefusal(null, null, value);
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
      const envelope = parseJsonEnvelope(item);
      if (envelope) visit(envelope);
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
