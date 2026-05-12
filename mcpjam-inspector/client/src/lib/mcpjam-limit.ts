import { useMCPJamLimitDialogStore } from "@/stores/mcpjam-limit-dialog-store";

const MCPJAM_MODEL_LIMIT_PATTERN = /mcpjam[\w\s-]*model limit/i;
const MCPJAM_RATE_LIMIT_CODE = "mcpjam_rate_limit";
const MCPJAM_USER_RATE_LIMIT_CODE = "user_rate_limit";
const MCPJAM_LIMIT_CODES = new Set([
  MCPJAM_RATE_LIMIT_CODE,
  MCPJAM_USER_RATE_LIMIT_CODE,
]);

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

/** Extract a JSON object embedded in a string. Backend errors come through
 * the AI SDK transport wrapped like `Backend stream error: 429 {"code":...}`,
 * so we accept either a full JSON string or one with a prefix. Returns null
 * for anything that isn't a top-level JSON object — we deliberately don't
 * dig further. */
const extractEmbeddedJsonObject = (
  value: string,
): Record<string, unknown> | null => {
  const parsed = tryParseJson(value);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }

  const jsonStart = value.indexOf("{");
  if (jsonStart > 0) {
    const parsedSuffix = tryParseJson(value.slice(jsonStart));
    if (
      parsedSuffix &&
      typeof parsedSuffix === "object" &&
      !Array.isArray(parsedSuffix)
    ) {
      return parsedSuffix as Record<string, unknown>;
    }
  }

  return null;
};

const limitKindFromShape = (
  shape: Record<string, unknown>,
): MCPJamLimitKind | undefined => {
  const value = shape.limitKind;
  return value === "total" || value === "concurrency" ? value : undefined;
};

export function isMCPJamModelLimitError(args: MCPJamLimitErrorInput): boolean {
  // Single source of truth for the concurrency carve-out: a transient
  // throttle resolves in seconds and is owned by the inline retry banner,
  // never the modal. Downstream consumers don't need to re-check.
  if (args.limitKind === "concurrency") return false;

  if (args.code && MCPJAM_LIMIT_CODES.has(args.code)) return true;

  // Only inspect well-defined shapes the backend actually emits:
  //   - `details` as an already-parsed object
  //   - `details` as a raw JSON string (notifyMCPJamLimitErrorFromResponse keeps
  //     the raw text when JSON.parse fails)
  //   - `message` as a JSON-prefixed string (AI SDK wraps SSE error chunks
  //     like `Backend stream error: 429 {"code":...}`)
  // We deliberately avoid walking arbitrary nested keys or substring-matching
  // the bare `user_rate_limit` identifier — those caught unrelated error
  // payloads that happened to mention the identifier in passing and opened
  // the modal for guests on their first send.
  const shapes: Array<Record<string, unknown>> = [];
  if (args.details && typeof args.details === "object") {
    shapes.push(args.details as Record<string, unknown>);
  } else if (typeof args.details === "string") {
    const embedded = extractEmbeddedJsonObject(args.details);
    if (embedded) shapes.push(embedded);
  }
  if (typeof args.message === "string" && args.message.length > 0) {
    const embedded = extractEmbeddedJsonObject(args.message);
    if (embedded) shapes.push(embedded);
  }

  for (const shape of shapes) {
    // Honor a concurrency carve-out declared alongside the code so a
    // throttle wrapped in a backend error string doesn't open the modal.
    if (limitKindFromShape(shape) === "concurrency") continue;

    const code = typeof shape.code === "string" ? shape.code : undefined;
    if (code && MCPJAM_LIMIT_CODES.has(code)) return true;

    const errorMessage =
      typeof shape.error === "string"
        ? shape.error
        : typeof shape.message === "string"
          ? shape.message
          : undefined;
    if (errorMessage && MCPJAM_MODEL_LIMIT_PATTERN.test(errorMessage)) {
      return true;
    }
  }

  if (
    typeof args.message === "string" &&
    MCPJAM_MODEL_LIMIT_PATTERN.test(args.message)
  ) {
    return true;
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
