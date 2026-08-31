import { describeError } from "@mcpjam/sdk/browser";
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
  const period = findMCPJamLimitPeriod(args.message);
  useMCPJamLimitDialogStore.getState().notifyLimitHit({
    limitKind: args.limitKind,
    organizationId: findMCPJamLimitOrganizationId(args),
    ...(args.surface ? { surface: args.surface } : {}),
    ...(period ? { period } : {}),
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
