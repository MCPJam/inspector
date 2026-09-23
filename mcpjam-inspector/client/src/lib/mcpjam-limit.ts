import { useFrontierSignInDialogStore } from "@/stores/frontier-sign-in-dialog-store";
import { isCreditExhaustion } from "@/shared/credit-exhaustion";
import { describeAsSlug, describeError } from "@mcpjam/sdk/browser";
import { useMCPJamLimitDialogStore } from "@/stores/mcpjam-limit-dialog-store";
import type { MCPJamLimitSurface } from "@/stores/mcpjam-limit-dialog-store";

/**
 * The organization's admin-set spend budget is exhausted for the current
 * billing window — emitted by the backend's `/stream` precheck and mirrored
 * by `ORGANIZATION_SPEND_BUDGET_REACHED` on the eval-launch mutations.
 *
 * Excluded by the shared credit classifier: credit exhaustion is what
 * opens the top-up dialog, and buying credits does not clear a budget. The
 * only fix is an owner or admin raising the cap, so this code carves itself
 * OUT of the model-limit classification and gets its own banner copy.
 */
export const SPEND_BUDGET_REACHED_CODE = "spend_budget_reached";

/** True when this error is the org spend budget refusing, not the wallet. */
export function isSpendBudgetReachedCode(code: string | undefined): boolean {
  return (
    code === SPEND_BUDGET_REACHED_CODE ||
    code === "ORGANIZATION_SPEND_BUDGET_REACHED"
  );
}

/**
 * The one sentence every surface shows for a budget refusal. Names the fix
 * (raise the cap) rather than the wallet, because the wallet is not what
 * refused.
 */
export const SPEND_BUDGET_REACHED_MESSAGE =
  "This organization's spend budget is reached. An owner or admin can raise it in Organization \u2192 Billing.";
export type MCPJamLimitKind = "total" | "concurrency";

/** Which allowance ran out. Free orgs draw on a daily bucket, Team orgs on a
 * monthly per-seat one, and the two want different advice — waiting is a night
 * in one case and up to a billing period in the other. */
export type MCPJamLimitPeriod = "daily" | "monthly";

/** The bucket is not empty, only smaller than this request's worst-case
 * estimate — sent with `refusalReason: "insufficient_for_request"`. */
export type MCPJamCreditShortfall = {
  creditsRemaining: number;
  creditsRequired: number;
};

type MCPJamLimitErrorInput = {
  code?: string;
  /** Stable run identity, shared by live streams and persisted failure updates. */
  runId?: string;
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

const findShortfallDeep = (
  value: unknown,
  seen = new WeakSet<object>(),
): MCPJamCreditShortfall | undefined => {
  if (!value || typeof value !== "object" || seen.has(value)) return undefined;
  seen.add(value);

  const item = value as Record<string, unknown>;
  const { creditsRemaining, creditsRequired } = item;
  if (
    item.refusalReason === "insufficient_for_request" &&
    typeof creditsRemaining === "number" &&
    Number.isInteger(creditsRemaining) &&
    typeof creditsRequired === "number" &&
    Number.isInteger(creditsRequired)
  ) {
    return { creditsRemaining, creditsRequired };
  }

  for (const nested of Object.values(item)) {
    const found = findShortfallDeep(nested, seen);
    if (found) return found;
  }
  return undefined;
};

const findMCPJamCreditShortfall = (
  args: MCPJamLimitErrorInput,
): MCPJamCreditShortfall | undefined => {
  for (const value of [args.details, args.message]) {
    const candidates =
      typeof value === "string" ? collectJsonCandidates(value) : [value];
    for (const candidate of candidates) {
      const shortfall = findShortfallDeep(candidate);
      if (shortfall) return shortfall;
    }
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

export function isMCPJamModelLimitError(args: MCPJamLimitErrorInput): boolean {
  return isCreditExhaustion(args);
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
  const shortfall = findMCPJamCreditShortfall(args);
  useMCPJamLimitDialogStore.getState().notifyLimitHit({
    ...(args.runId ? { runId: args.runId } : {}),
    limitKind: args.limitKind,
    organizationId: findMCPJamLimitOrganizationId(args),
    ...(args.surface ? { surface: args.surface } : {}),
    ...(period ? { period } : {}),
    ...(shortfall ? { shortfall } : {}),
  });
  return true;
}

const MCPJAM_LIMIT_SLUGS = new Set([
  "provider/mcpjam_limit_daily",
  "provider/mcpjam_limit_monthly",
  "provider/mcpjam_limit_insufficient",
  "provider/mcpjam_limit",
]);

const MCPJAM_HOLDS_COMMITTED_MESSAGE =
  "Other requests in flight are holding your remaining MCPJam credits. Try again in a few seconds.";

/**
 * One plain sentence for a limit refusal, for surfaces that print an error
 * string inline (the agent side panel, the generation workspace). The dialog
 * carries the actions; without this those surfaces echo the raw JSON body the
 * backend refused with, which reads as a crash. `null` for anything that
 * isn't a limit error, so callers keep their own message.
 *
 * A `holds_committed` refusal gets its own line: no dialog opens for it, and
 * the fix is to retry in a moment, not to buy anything.
 */
export function describeMCPJamLimitMessage(
  message: string | null | undefined,
): string | null {
  if (!message) return null;
  if (
    collectJsonCandidates(message).some(
      (parsed) =>
        findStringPropertyDeep(parsed, "refusalReason") === "holds_committed",
    )
  ) {
    return MCPJAM_HOLDS_COMMITTED_MESSAGE;
  }
  if (!isMCPJamModelLimitError({ message })) return null;
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
