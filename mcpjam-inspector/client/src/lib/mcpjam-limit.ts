import { useFrontierSignInDialogStore } from "@/stores/frontier-sign-in-dialog-store";
import { describeAsSlug, describeError } from "@mcpjam/sdk/browser";
import { useMCPJamLimitDialogStore } from "@/stores/mcpjam-limit-dialog-store";
import type { MCPJamLimitSurface } from "@/stores/mcpjam-limit-dialog-store";

// Bounded for the same reason as the SDK describer's copy of this phrase:
// `[\w\s-]` matches "mcpjam" too, so unbounded it backtracks quadratically on a
// wire message of repeated "mcpjam" that never reaches "model limit".
const MCPJAM_MODEL_LIMIT_PATTERN = /mcpjam[\w\s-]{0,40}model limit/i;
const MCPJAM_RATE_LIMIT_CODE = "mcpjam_rate_limit";
const MCPJAM_USER_RATE_LIMIT_CODE = "user_rate_limit";
const MCPJAM_LIMIT_CODES = new Set([
  MCPJAM_RATE_LIMIT_CODE,
  MCPJAM_USER_RATE_LIMIT_CODE,
]);

/**
 * The organization's admin-set spend budget is exhausted for the current
 * billing window — emitted by the backend's `/stream` precheck and mirrored
 * by `ORGANIZATION_SPEND_BUDGET_REACHED` on the eval-launch mutations.
 *
 * Deliberately NOT a member of {@link MCPJAM_LIMIT_CODES}: that set is what
 * opens the top-up dialog, and buying credits does not clear a budget. The
 * only fix is an owner or admin raising the cap, so this code carves itself
 * OUT of the model-limit classification and gets its own banner copy.
 */
export const SPEND_BUDGET_REACHED_CODE = "spend_budget_reached";

/** True when this error is the org spend budget refusing, not the wallet. */
export function isSpendBudgetReachedCode(code: string | undefined): boolean {
  return code === SPEND_BUDGET_REACHED_CODE;
}

/**
 * The one sentence every surface shows for a budget refusal. Names the fix
 * (raise the cap) rather than the wallet, because the wallet is not what
 * refused.
 */
export const SPEND_BUDGET_REACHED_MESSAGE =
  "This organization's spend budget is reached. An owner or admin can raise it in Organization \u2192 Billing.";
const MCPJAM_RATE_LIMIT_CODE_PATTERN =
  /\b(?:mcpjam_rate_limit|user_rate_limit)\b/;

export type MCPJamLimitKind = "total" | "concurrency";

/** Which allowance ran out. Free orgs draw on a daily bucket, Team orgs on a
 * monthly per-seat one, and the two want different advice — waiting is a night
 * in one case and up to a billing period in the other. */
export type MCPJamLimitPeriod = "daily" | "monthly";

type MCPJamLimitErrorInput = {
  code?: string;
  message?: string | null;
  details?: unknown;
  organizationId?: string;
  /** Sub-classification of a rate-limit error. `"concurrency"` is a transient
   * throttle whose UI lives inline (retry banner) — never opens the modal. */
  limitKind?: MCPJamLimitKind;
  /** Which screen hit the wall; see `MCPJamLimitSurface`. Only affects which
   * actions the dialog offers, never whether it opens. */
  surface?: MCPJamLimitSurface;
};

const getStringProperty = (value: unknown, key: string): string | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const item = (value as Record<string, unknown>)[key];
  return typeof item === "string" ? item : undefined;
};

const tryParseJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const collectJsonCandidates = (value: string): unknown[] => {
  const candidates: unknown[] = [];
  const parsed = tryParseJson(value);
  if (parsed !== null) {
    candidates.push(parsed);
  }

  const jsonStart = value.indexOf("{");
  if (jsonStart > 0) {
    const parsedSuffix = tryParseJson(value.slice(jsonStart));
    if (parsedSuffix !== null) {
      candidates.push(parsedSuffix);
    }
  }

  return candidates;
};

const collectStringValues = (
  value: unknown,
  strings: string[] = [],
  seen = new WeakSet<object>(),
): string[] => {
  if (typeof value === "string") {
    strings.push(value);
    return strings;
  }

  if (!value || typeof value !== "object") {
    return strings;
  }

  if (seen.has(value)) {
    return strings;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStringValues(item, strings, seen);
    }
    return strings;
  }

  for (const item of Object.values(value)) {
    collectStringValues(item, strings, seen);
  }

  return strings;
};

const findMCPJamRateLimitCode = (
  value: unknown,
  seen = new WeakSet<object>(),
): string | undefined => {
  if (!value || typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (
    "code" in value &&
    typeof (value as { code?: unknown }).code === "string" &&
    MCPJAM_LIMIT_CODES.has((value as { code: string }).code)
  ) {
    return (value as { code: string }).code;
  }

  const values = Array.isArray(value) ? value : Object.values(value);
  for (const item of values) {
    const code = findMCPJamRateLimitCode(item, seen);
    if (code) return code;
  }

  return undefined;
};

/**
 * The spend-budget code, wherever it is nested.
 *
 * The top-level `code` is not the only place it arrives: a refusal can reach
 * the client with the code inside `details`, or inside a JSON-encoded
 * `message`. Missing it there is not a cosmetic slip — the deep scan below
 * would then classify the same refusal as a wallet limit and open the top-up
 * dialog, selling credits to an organization that set its own ceiling and
 * cannot spend its way past it.
 */
/**
 * Ask MCPJam's refusals, which are about MCPJAM's budget, not the customer's.
 *
 * `platform_capacity` is MCPJam's own daily budget for the feature;
 * `agent_turn_limit` is a per-user COUNT; `agent_billing_rejected` means the
 * claim did not hold at all. None of them is a wallet the caller can top up,
 * and all three arrive on a surface the product tells people is free — so
 * opening the credits dialog for one would sell credits against a refusal
 * buying credits cannot lift. Listed here, with the other account-state
 * refusals, so they are also screened at every nesting level: these codes ride
 * inside `details` and JSON-encoded `message` as readily as at the top.
 */
const AGENT_REFUSAL_CODES = new Set([
  "platform_capacity",
  "agent_turn_limit",
  "agent_billing_rejected",
]);

const isInlineAccountRefusal = (code: unknown): boolean =>
  code === "platform_free_budget_exhausted" ||
  code === "account_suspended" ||
  (typeof code === "string" && AGENT_REFUSAL_CODES.has(code)) ||
  isSpendBudgetReachedCode(typeof code === "string" ? code : undefined);

const hasNestedSpendBudgetCode = (
  value: unknown,
  seen = new WeakSet<object>(),
): boolean => {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);

  if (isInlineAccountRefusal(getStringProperty(value, "code"))) return true;

  const values = Array.isArray(value) ? value : Object.values(value);
  for (const item of values) {
    // A STRING LEAF CAN BE JSON. Servers routinely nest an encoded error
    // inside `details` or a `message` field, and stopping at the string is
    // how the budget code hides from this walk — leaving the deep scan below
    // to read the same payload's rate-limit text and open the top-up dialog.
    if (typeof item === "string") {
      if (isInlineAccountRefusal(item)) return true;
      for (const parsed of collectJsonCandidates(item)) {
        if (hasNestedSpendBudgetCode(parsed, seen)) return true;
      }
      continue;
    }
    if (hasNestedSpendBudgetCode(item, seen)) return true;
  }

  return false;
};

const findMCPJamLimitKind = (
  value: unknown,
  seen = new WeakSet<object>(),
): MCPJamLimitKind | undefined => {
  if (!value || typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  const limitKind = getStringProperty(value, "limitKind");
  if (limitKind === "total" || limitKind === "concurrency") {
    return limitKind;
  }

  const values = Array.isArray(value) ? value : Object.values(value);
  for (const item of values) {
    const nestedLimitKind = findMCPJamLimitKind(item, seen);
    if (nestedLimitKind) return nestedLimitKind;
  }

  return undefined;
};

const findStringPropertyDeep = (
  value: unknown,
  key: string,
  seen = new WeakSet<object>(),
): string | undefined => {
  if (!value || typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  const direct = getStringProperty(value, key);
  if (direct) return direct;

  const values = Array.isArray(value) ? value : Object.values(value);
  for (const item of values) {
    const nested = findStringPropertyDeep(item, key, seen);
    if (nested) return nested;
  }

  return undefined;
};

const findMCPJamLimitOrganizationId = (
  args: MCPJamLimitErrorInput,
): string | undefined => {
  if (args.organizationId) return args.organizationId;

  for (const value of [args.details, args.message]) {
    if (typeof value === "string") {
      for (const parsed of collectJsonCandidates(value)) {
        const organizationId = findStringPropertyDeep(parsed, "organizationId");
        if (organizationId) return organizationId;
      }
      continue;
    }

    const organizationId = findStringPropertyDeep(value, "organizationId");
    if (organizationId) return organizationId;
  }

  return undefined;
};

/**
 * Read the period off the SDK catalog rather than a second regex here. The
 * error card already classifies this exact message through `describeError`, so
 * routing the dialog through it too is what keeps them from ever disagreeing
 * about which allowance ran out.
 */
const findMCPJamLimitPeriod = (
  message: string | null | undefined,
): MCPJamLimitPeriod | undefined => {
  if (!message) return undefined;
  const { slug } = describeError(message);
  if (slug === "provider/mcpjam_limit_daily") return "daily";
  if (slug === "provider/mcpjam_limit_monthly") return "monthly";
  return undefined;
};

const isMCPJamLimitString = (value: string): boolean =>
  MCPJAM_MODEL_LIMIT_PATTERN.test(value) ||
  MCPJAM_RATE_LIMIT_CODE_PATTERN.test(value);

export function isMCPJamModelLimitError(args: MCPJamLimitErrorInput): boolean {
  // Single source of truth for the concurrency carve-out: a transient
  // throttle resolves in seconds and is owned by the inline retry banner,
  // never the modal. Downstream consumers don't need to re-check.
  if (args.limitKind === "concurrency") return false;

  // Same shape of carve-out for the org spend budget: it is a refusal the
  // user cannot buy their way out of, so it must never reach the top-up
  // modal. Checked before the deep scans below so a budget payload that
  // happens to embed a rate-limit string still classifies as a budget —
  // and checked at EVERY nesting level, because the code arrives inside
  // `details` or a JSON-encoded `message` as readily as at the top.
  if (isInlineAccountRefusal(args.code)) return false;
  for (const value of [args.message, args.details]) {
    if (typeof value === "string") {
      if (isInlineAccountRefusal(value)) return false;
      for (const parsed of collectJsonCandidates(value)) {
        if (hasNestedSpendBudgetCode(parsed)) return false;
      }
      continue;
    }
    if (hasNestedSpendBudgetCode(value)) return false;
  }

  if (args.code === MCPJAM_RATE_LIMIT_CODE) return true;
  if (args.code === MCPJAM_USER_RATE_LIMIT_CODE) return true;

  const valuesToInspect = [args.message, args.details];
  for (const value of valuesToInspect) {
    if (typeof value === "string") {
      for (const parsed of collectJsonCandidates(value)) {
        const code = findMCPJamRateLimitCode(parsed);
        const limitKind = findMCPJamLimitKind(parsed);
        const hasLimitString = collectStringValues(parsed).some((item) =>
          isMCPJamLimitString(item),
        );
        if (
          limitKind === "concurrency" &&
          (code === MCPJAM_USER_RATE_LIMIT_CODE || hasLimitString)
        ) {
          return false;
        }
        if (code || hasLimitString) return true;
      }

      if (isMCPJamLimitString(value)) return true;
      continue;
    }

    const code = findMCPJamRateLimitCode(value);
    const limitKind = findMCPJamLimitKind(value);
    const hasLimitString = collectStringValues(value).some((item) =>
      isMCPJamLimitString(item),
    );
    if (
      limitKind === "concurrency" &&
      (code === MCPJAM_USER_RATE_LIMIT_CODE || hasLimitString)
    ) {
      return false;
    }
    if (code || hasLimitString) return true;
  }

  return false;
}

const hasFrontierSignInCode = (
  value: unknown,
  seen = new WeakSet<object>(),
): boolean => {
  if (typeof value === "string") {
    return collectJsonCandidates(value).some((parsed) =>
      hasFrontierSignInCode(parsed, seen),
    );
  }
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);

  if (getStringProperty(value, "code") === "guest_model_not_allowed") return true;
  return Object.values(value).some((item) => hasFrontierSignInCode(item, seen));
};

export function notifyMCPJamLimitError(args: MCPJamLimitErrorInput): boolean {
  // Authentication gating is not credit exhaustion: do not mark the wallet empty.
  if (
    hasFrontierSignInCode(args) ||
    [args.message, ...collectStringValues(args.details)].some(
      (value) =>
        typeof value === "string" &&
        /sign in to use frontier models/i.test(value),
    )
  ) {
    useFrontierSignInDialogStore.getState().open();
    return true;
  }
  if (!isMCPJamModelLimitError(args)) return false;
  const period = findMCPJamLimitPeriod(args.message);
  useMCPJamLimitDialogStore.getState().notifyLimitHit({
    limitKind: args.limitKind,
    organizationId: findMCPJamLimitOrganizationId(args),
    ...(args.surface ? { surface: args.surface } : {}),
    ...(period ? { period } : {}),
  });
  return true;
}

const MCPJAM_LIMIT_SLUGS = new Set([
  "provider/mcpjam_limit_daily",
  "provider/mcpjam_limit_monthly",
  "provider/mcpjam_limit",
]);

/**
 * One plain sentence for a limit refusal, for surfaces that print an error
 * string inline (the agent side panel, the generation workspace). The dialog
 * carries the actions; without this those surfaces echo the raw JSON body the
 * backend refused with, which reads as a crash. `null` for anything that
 * isn't a limit error, so callers keep their own message.
 */
/**
 * The 503 a refused platform hold answers when MCPJam's own guard failed
 * closed, as opposed to its budget being spent. Nothing lifts it at midnight,
 * so it must not be shown as a daily limit.
 */
const AGENT_UNAVAILABLE_CODES = new Set([
  "platform_generation_unavailable",
  "agent_billing_rejected",
]);

/** Every code, at any nesting depth, that a refusal body carries. */
const collectCodes = (
  value: unknown,
  out: Set<string>,
  seen = new WeakSet<object>(),
): void => {
  if (typeof value === "string") {
    for (const parsed of collectJsonCandidates(value)) {
      collectCodes(parsed, out, seen);
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  const code = getStringProperty(value, "code");
  if (code) out.add(code);
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    collectCodes(item, out, seen);
  }
};

/**
 * One plain sentence for an Ask MCPJam refusal, or `null` when the error is
 * something else.
 *
 * The agent is free, so none of these is a wallet the reader can top up, and
 * the raw body they arrive as reads as a crash. The two sentences say the only
 * two things worth saying: come back after the reset, or this is ours and it is
 * temporary.
 */
export function describeAgentRefusalMessage(
  message: string | null | undefined,
): string | null {
  if (!message) return null;
  const codes = new Set<string>();
  collectCodes(message, codes);
  // Unconditional, not a fallback for an unparseable body. `collectCodes` only
  // records a `code` PROPERTY, so a refusal nested as plain text under some
  // other envelope — `{"code":"RATE_LIMITED","details":"agent_turn_limit"}` —
  // leaves a non-empty set that does not contain the code that actually
  // matters, and gating the scan on `size === 0` would skip it and print the
  // raw body. These codes are distinctive enough (none is an English word)
  // that scanning always costs nothing.
  for (const code of [...AGENT_REFUSAL_CODES, ...AGENT_UNAVAILABLE_CODES]) {
    if (message.includes(code)) codes.add(code);
  }
  for (const code of AGENT_UNAVAILABLE_CODES) {
    if (codes.has(code)) return "Ask MCPJam is temporarily unavailable.";
  }
  if (codes.has("platform_capacity") || codes.has("agent_turn_limit")) {
    return "Ask MCPJam has reached today's limit. It resets at 00:00 UTC.";
  }
  return null;
}

export function describeMCPJamLimitMessage(
  message: string | null | undefined,
): string | null {
  if (!message || !isMCPJamModelLimitError({ message })) return null;
  const described = describeError(message);
  const entry = MCPJAM_LIMIT_SLUGS.has(described.slug)
    ? described
    : describeAsSlug("provider/mcpjam_limit", message);
  return `${entry.title}. ${entry.oneLine}`;
}

export async function notifyMCPJamLimitErrorFromResponse(
  response: Response,
  surface?: MCPJamLimitSurface,
): Promise<boolean> {
  let details: unknown;
  let message: string | null = null;

  try {
    const text = await response.clone().text();
    message = text || `Request failed (${response.status})`;
    details = text;

    try {
      details = JSON.parse(text);
      message =
        getStringProperty(details, "message") ??
        getStringProperty(details, "error") ??
        message;
    } catch {
      // Keep raw text details.
    }
  } catch {
    message = `Request failed (${response.status})`;
  }

  const limitKind = getStringProperty(details, "limitKind");

  return notifyMCPJamLimitError({
    code: getStringProperty(details, "code"),
    details,
    message,
    limitKind:
      limitKind === "total" || limitKind === "concurrency"
        ? limitKind
        : undefined,
    ...(surface ? { surface } : {}),
  });
}
