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
];

const ALLOWLISTED_KEYS = new Set(["emaildomain"]);

const TOKEN_LIKE = /\bBearer\s+[A-Za-z0-9._\-+/=]+\b/gi;
const EMAIL_LIKE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const SK_KEY_LIKE = /\bsk-[A-Za-z0-9]{16,}\b/g;
const JWT_LIKE =
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

function isForbiddenKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (ALLOWLISTED_KEYS.has(lower)) return false;
  if (lower === "email" || lower.endsWith("email")) return true;
  return FORBIDDEN_KEY_SUBSTRINGS.some((s) => lower.includes(s));
}

function scrubString(s: string): string {
  return s
    .replace(TOKEN_LIKE, "Bearer [redacted-token]")
    .replace(JWT_LIKE, "[redacted-jwt]")
    .replace(EMAIL_LIKE, "[redacted-email]")
    .replace(SK_KEY_LIKE, "[redacted-secret]");
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
