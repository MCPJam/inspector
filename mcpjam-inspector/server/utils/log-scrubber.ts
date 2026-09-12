import {
  authHeaderLike,
  jwtLike,
  secretParamLike,
  skKeyLike,
  tokenLike,
  urlBasicAuthLike,
} from "../../shared/secret-shape-redaction";

const FORBIDDEN_KEY_SUBSTRINGS = [
  "authorization",
  "cookie",
  "password",
  "token",
  "secret",
  "apikey",
  "pkceverifier",
  "pkcechallenge",
  "stripecustomer",
  "stripesubscription",
  "stripeprice",
  "x-mcp-session-auth",
  "x-api-key",
  // Header-broker model lease (E2B network-transform delivery). A signed model
  // lease — never log it, even though the inspector never handles it directly
  // (defense in depth).
  "x-mcpjam-harness-lease",
];

const ALLOWLISTED_KEYS = new Set(["emaildomain"]);

// THE CREDENTIAL PATTERNS NOW LIVE IN `shared/secret-shape-redaction.ts`.
//
// They were written here, for logs, and stayed here — with `logger.ts` as
// their only consumer — while the browser path grew three places that hand
// page-controlled and upstream-controlled text straight to a model. Moving
// them made that path reachable; importing them back keeps this file the one
// that decides what a LOG does, which is a stricter question than what a model
// may read.
//
// The factories mint a fresh regex per call. Every one carries `g`, and a
// global regex is stateful: a shared instance's `lastIndex` survives between
// calls and silently skips the first match of every other string.
//
// `EMAIL_LIKE` stays HERE, deliberately. A log has no reason to carry an
// address; a model reading a page does, and redacting one from an
// accessibility tree would blank out the field it is trying to fill.
const EMAIL_LIKE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

function isForbiddenKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (ALLOWLISTED_KEYS.has(lower)) return false;
  if (lower === "email" || lower.endsWith("email")) return true;
  return FORBIDDEN_KEY_SUBSTRINGS.some((s) => lower.includes(s));
}

function scrubString(s: string): string {
  // The SAME patterns as the model path, with this file's own replacement
  // strings: a log reader benefits from knowing which kind of secret was
  // there, and existing log-scrubber tests pin these exact words.
  return s
    .replace(authHeaderLike(), "$1[redacted]")
    .replace(tokenLike(), "Bearer [redacted-token]")
    .replace(jwtLike(), "[redacted-jwt]")
    .replace(urlBasicAuthLike(), "$1[redacted]@")
    .replace(EMAIL_LIKE, "[redacted-email]")
    .replace(skKeyLike(), "[redacted-secret]")
    .replace(secretParamLike(), "$1[redacted]");
}

export function scrubLogPayload<T>(value: T): T {
  return scrubValue(value, new WeakSet()) as T;
}

function scrubValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return scrubString(value);
  if (typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubString(value.message),
      stack: value.stack ? scrubString(value.stack) : undefined,
    };
  }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return "[buffer]";
  }
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, seen));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isForbiddenKey(k)) {
      out[k] = "[redacted]";
      continue;
    }
    out[k] = scrubValue(v, seen);
  }
  return out;
}
