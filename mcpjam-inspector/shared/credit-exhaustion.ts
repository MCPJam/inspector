import {
  creditRecoveryOfRefusal,
  type CreditRecovery,
} from "@mcpjam/sdk/contract";
import {
  EXHAUSTION_PHRASES,
  isDeclinedCardRefusal,
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

/**
 * A refusal after a declined card paused auto-reload, read the way
 * {@link isHoldRefusal} reads a hold: a structured `refusalReason` at any
 * depth decides; without one, only the refusal's own words count, so an
 * earlier decline quoted in its history does not relabel a new exhaustion.
 *
 * It is still credit exhaustion (a run stops on it), but the out-of-credits
 * dialog does not name the card, so a surface that does can show it instead.
 */
export const isDeclinedCardLimit = (value: unknown): boolean => {
  const reason = findRefusalReason(value);
  if (reason) return isDeclinedCardRefusal(reason);
  const root = refusalRoot(value);
  const own = root
    ? [...OWN_MESSAGE_KEYS.map((key) => root[key]), root.details]
    : [value];
  return own.some(
    (text) => typeof text === "string" && isDeclinedCardRefusal(null, text),
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
      const envelope = parseJsonEnvelope(item);
      if (envelope) visit(envelope);
      return;
    }
    if (!item || typeof item !== "object" || seen.has(item)) return;
    seen.add(item);
    // Provider balances belong to the customer's API account. Their wording
    // can include "insufficient credits", but MCPJam credits cannot fix them.
    const code = (item as Record<string, unknown>).code;
    if (typeof code === "string" && /^provider_/.test(code)) excluded = true;
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

/**
 * The two spend limits that stop a run without being an empty wallet: an
 * owner's spend budget, and a wallet MCPJam locked. Each has exactly one way
 * out, and neither is a purchase: buying credits raises no budget and unlocks
 * no wallet.
 */
type SpendLimit = "budget" | "wallet";

const SPEND_LIMIT_BY_REASON: Readonly<Record<string, SpendLimit>> = {
  budget_reached: "budget",
  wallet_locked: "wallet",
};

const SPEND_LIMIT_BY_CODE: Readonly<Record<string, SpendLimit>> = {
  spend_budget_reached: "budget",
  organization_spend_budget_reached: "budget",
  wallet_locked: "wallet",
};

const SPEND_LIMIT_CODE =
  /\b(?:spend_budget_reached|organization_spend_budget_reached|wallet_locked)\b/i;

const SPEND_LIMIT_RECOVERY: Readonly<
  Record<SpendLimit, Pick<CreditRecovery, "reason" | "action" | "actor">>
> = {
  budget: {
    reason: "budget_reached",
    action: "raise_budget",
    actor: "owner_or_admin",
  },
  wallet: {
    reason: "wallet_locked",
    action: "contact_support",
    actor: "support",
  },
};

/**
 * Does this code name a spend budget or a locked wallet? Both are terminal for
 * a run; a rate-limit code such as `mcpjam_rate_limit` can be a gateway's
 * transient throttle and is not.
 */
export const isSpendLimitCode = (code: string): boolean =>
  SPEND_LIMIT_CODE.test(code);

/**
 * Which spend limit a refusal names, if any. A structured `refusalReason`
 * decides alone; without one, MCPJam's code anywhere in the refusal does. A
 * provider's own error (a `provider_` code) is never MCPJam's limit.
 */
const spendLimitOf = (value: unknown): SpendLimit | undefined => {
  if (isHoldRefusal(value)) return undefined;
  const fromProvider = someNested(
    value,
    (item) =>
      !!item &&
      typeof item === "object" &&
      typeof (item as Record<string, unknown>).code === "string" &&
      /^provider_/.test((item as Record<string, unknown>).code as string),
  );
  if (fromProvider) return undefined;
  const reason = findRefusalReason(value);
  if (reason) {
    return Object.hasOwn(SPEND_LIMIT_BY_REASON, reason)
      ? SPEND_LIMIT_BY_REASON[reason]
      : undefined;
  }
  let limit: SpendLimit | undefined;
  someNested(value, (item) => {
    const code = typeof item === "string" ? SPEND_LIMIT_CODE.exec(item) : null;
    if (!code) return false;
    limit = SPEND_LIMIT_BY_CODE[code[0].toLowerCase()];
    return true;
  });
  return limit;
};

/**
 * The limit's one step: the refusal's own recovery when it names that step
 * (its link and actor are the backend's), otherwise the step without a link.
 * A purchase step on a spend limit is the backend misreading it, never shown.
 */
const spendLimitRecovery = (
  limit: SpendLimit,
  carried: CreditRecovery | undefined,
): CreditRecovery => {
  const step = SPEND_LIMIT_RECOVERY[limit];
  return carried?.action === step.action ? carried : { version: 1, ...step };
};

/**
 * A refusal that stops a run: credit exhaustion, a spend budget, or a locked
 * wallet, with the step to recover. `undefined` for anything else, a hold
 * included. The step is read only off a refusal already known to be MCPJam's.
 */
export function runStopRefusal(
  value: unknown,
): { recovery?: CreditRecovery } | undefined {
  if (isCreditExhaustion(value)) {
    const recovery = creditRecoveryOfRefusal(value);
    return recovery ? { recovery } : {};
  }
  const limit = spendLimitOf(value);
  return limit
    ? { recovery: spendLimitRecovery(limit, creditRecoveryOfRefusal(value)) }
    : undefined;
}

/**
 * A recovery stored beside a refusal's code, when that code may carry it: a
 * credit exhaustion code carries what was recorded, a spend limit only its own
 * step. Any other code carries none.
 */
export function recoveryForStopCode(
  code: string,
  recorded: CreditRecovery | undefined,
): CreditRecovery | undefined {
  if (!recorded) return undefined;
  if (isCreditExhaustion(code)) return recorded;
  const limit = spendLimitOf(code);
  return limit && SPEND_LIMIT_RECOVERY[limit].action === recorded.action
    ? recorded
    : undefined;
}
