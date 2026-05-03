import { useMCPJamLimitDialogStore } from "@/stores/mcpjam-limit-dialog-store";

const MCPJAM_MODEL_LIMIT_PATTERN = /mcpjam[\w\s-]*model limit/i;
const MCPJAM_RATE_LIMIT_CODE = "mcpjam_rate_limit";
const MCPJAM_USER_RATE_LIMIT_CODE = "user_rate_limit";
const MCPJAM_LIMIT_CODES = new Set([
  MCPJAM_RATE_LIMIT_CODE,
  MCPJAM_USER_RATE_LIMIT_CODE,
]);
const MCPJAM_RATE_LIMIT_CODE_PATTERN =
  /\b(?:mcpjam_rate_limit|user_rate_limit)\b/;

export type MCPJamLimitKind = "total" | "concurrency";

type MCPJamLimitErrorInput = {
  code?: string;
  message?: string | null;
  details?: unknown;
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
  useMCPJamLimitDialogStore.getState().notifyLimitHit({
    limitKind: args.limitKind,
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
