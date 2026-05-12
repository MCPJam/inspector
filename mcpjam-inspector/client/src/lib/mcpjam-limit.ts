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

/** Expand `value` into the top-level JSON object(s) we're willing to
 * inspect for a rate-limit signal. Recurses one extra level into a
 * stringified `details` field so backend stream errors wrapped by
 * `formatStreamError` as `{message, details: "<raw upstream JSON>"}`
 * still surface the upstream `code`/`limitKind`. */
const collectShapes = (
  value: unknown,
  shapes: Record<string, unknown>[],
): void => {
  let shape: Record<string, unknown> | null = null;
  if (value && typeof value === "object") {
    shape = value as Record<string, unknown>;
  } else if (typeof value === "string" && value.length > 0) {
    shape = extractEmbeddedJsonObject(value);
  }
  if (!shape) return;
  shapes.push(shape);
  if (typeof shape.details === "string") {
    const inner = extractEmbeddedJsonObject(shape.details);
    if (inner) shapes.push(inner);
  }
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
  //   - a stringified `shape.details` one level deeper — the inspector's
  //     `formatStreamError` wraps non-auth backend errors as
  //     `{message, details: "<raw response body>"}`, so the real rate-limit
  //     code lives nested in `details`.
  // We deliberately avoid walking arbitrary nested keys or substring-matching
  // the bare `user_rate_limit` identifier — those caught unrelated error
  // payloads that happened to mention the identifier in passing and opened
  // the modal for guests on their first send.
  const shapes: Array<Record<string, unknown>> = [];
  collectShapes(args.details, shapes);
  collectShapes(args.message, shapes);

  // First pass: a concurrency carve-out declared anywhere in the
  // inspected shapes is global — the wrapper produced by
  // `formatStreamError` and its parsed `details` describe the same
  // error, so neither a sibling shape's `message` field nor the raw
  // message regex below should re-open the modal for a transient
  // throttle.
  for (const shape of shapes) {
    if (limitKindFromShape(shape) === "concurrency") return false;
  }

  for (const shape of shapes) {
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
