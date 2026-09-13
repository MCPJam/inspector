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

// Credential patterns live in `shared/secret-shape-redaction.ts`, shared with
// the model path. They are factories: each regex has `g`, and a shared
// instance's `lastIndex` would skip matches between calls.
//
// `EMAIL_LIKE` stays here: logs redact addresses, but a model reading a page
// needs them.
const EMAIL_LIKE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

function isForbiddenKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (ALLOWLISTED_KEYS.has(lower)) return false;
  if (lower === "email" || lower.endsWith("email")) return true;
  return FORBIDDEN_KEY_SUBSTRINGS.some((s) => lower.includes(s));
}

function scrubString(s: string): string {
  // Same patterns as the model path, with log-specific replacement strings.
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
