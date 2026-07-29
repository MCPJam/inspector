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

// A full `Authorization:` header value, whatever the scheme. `SECRET_PARAM_LIKE`
// below stops at the first whitespace, which is correct for a query param but
// leaves a header's credential exposed: `Authorization: Basic dXNlcjpwYXNz`
// redacted only the word "Basic". `Bearer` survived that gap purely because
// TOKEN_LIKE happened to catch it; `Basic`, `Digest` and `Negotiate` did not.
// Consumes to end of line, stopping at a quote so a JSON-embedded header
// (`{"authorization":"Basic …","keep":"me"}`) doesn't swallow its siblings.
// Runs FIRST so the whole value is gone before any narrower pattern nibbles it.
// The optional quote before the colon matters for the JSON spelling
// (`"authorization":"Basic …"`), where the key's closing quote sits between
// the name and the separator.
const AUTH_HEADER_LIKE = /\b(authorization["']?\s*:\s*)["']?[^\n\r"'`]+/gi;
const TOKEN_LIKE = /\bBearer\s+[A-Za-z0-9._\-+/=]+\b/gi;
const EMAIL_LIKE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const SK_KEY_LIKE = /\bsk-[A-Za-z0-9]{16,}\b/g;
const JWT_LIKE =
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
// Secret-ish `key=value` / `key: value` pairs embedded in strings — raw
// upstream error messages routinely quote full URLs
// (`...?api_key=plain-secret`), which the key-based redaction above can't
// see. Over-redaction is acceptable in logs, so the key list is broad.
// `authorization` is spelled out ahead of `auth`: the object-key scrubber
// already treats it as a secret, but `auth` alone can't match it (the trailing
// `orization` blocks the `[=:]`), so `?authorization=…` used to survive inside
// a quoted URL. camelCase spellings (`accessToken`, `clientSecret`) already
// match via the `[_-]?` separator plus the `i` flag.
const SECRET_PARAM_LIKE =
  /\b((?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|authorization|secret|password|passwd|pwd|token|auth|key|sig|signature)\s*[=:]\s*["']?)[^&\s"'`]+/gi;
// Basic-auth credentials in URLs: `https://user:pass@host/...`. Must run
// BEFORE the email pattern, which otherwise consumes `pass@host` as an
// address and leaves a mangled remainder this pattern can't match.
const URL_BASIC_AUTH_LIKE = /(\/\/[^\s/:@]+:)[^\s@/]+@/g;

function isForbiddenKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (ALLOWLISTED_KEYS.has(lower)) return false;
  if (lower === "email" || lower.endsWith("email")) return true;
  return FORBIDDEN_KEY_SUBSTRINGS.some((s) => lower.includes(s));
}

function scrubString(s: string): string {
  return s
    .replace(AUTH_HEADER_LIKE, "$1[redacted]")
    .replace(TOKEN_LIKE, "Bearer [redacted-token]")
    .replace(JWT_LIKE, "[redacted-jwt]")
    .replace(URL_BASIC_AUTH_LIKE, "$1[redacted]@")
    .replace(EMAIL_LIKE, "[redacted-email]")
    .replace(SK_KEY_LIKE, "[redacted-secret]")
    .replace(SECRET_PARAM_LIKE, "$1[redacted]");
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
