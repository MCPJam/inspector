import { useMCPJamLimitDialogStore } from "@/stores/mcpjam-limit-dialog-store";

const MCPJAM_MODEL_LIMIT_PATTERN = /mcpjam[\w\s-]*model limit/i;
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
  "This organization's spend budget is reached. An owner or admin can raise it in Organization \u2192 Budget.";
const MCPJAM_RATE_LIMIT_CODE_PATTERN =
  /\b(?:mcpjam_rate_limit|user_rate_limit)\b/;

export type MCPJamLimitKind = "total" | "concurrency";

type MCPJamLimitErrorInput = {
  code?: string;
  message?: string | null;
  details?: unknown;
  organizationId?: string;
  /** Sub-classification of a rate-limit error. `"concurrency"` is a transient
   * throttle whose UI lives inline (retry banner) — never opens the modal. */
  limitKind?: MCPJamLimitKind;
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
const hasNestedSpendBudgetCode = (
  value: unknown,
  seen = new WeakSet<object>(),
): boolean => {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);

  if (isSpendBudgetReachedCode(getStringProperty(value, "code"))) return true;

  const values = Array.isArray(value) ? value : Object.values(value);
  for (const item of values) {
    // A STRING LEAF CAN BE JSON. Servers routinely nest an encoded error
    // inside `details` or a `message` field, and stopping at the string is
    // how the budget code hides from this walk — leaving the deep scan below
    // to read the same payload's rate-limit text and open the top-up dialog.
    if (typeof item === "string") {
      if (isSpendBudgetReachedCode(item)) return true;
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
  if (isSpendBudgetReachedCode(args.code)) return false;
  for (const value of [args.message, args.details]) {
    if (typeof value === "string") {
      if (isSpendBudgetReachedCode(value)) return false;
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

export function notifyMCPJamLimitError(args: MCPJamLimitErrorInput): boolean {
  if (!isMCPJamModelLimitError(args)) return false;
  useMCPJamLimitDialogStore.getState().notifyLimitHit({
    limitKind: args.limitKind,
    organizationId: findMCPJamLimitOrganizationId(args),
  });
  return true;
}

export async function notifyMCPJamLimitErrorFromResponse(
  response: Response,
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
  });
}
