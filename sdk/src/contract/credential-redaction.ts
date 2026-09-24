/**
 * Credential redaction, byte-identical to the hosted one.
 *
 * The first pass of the egress redactor (`./egress-text.ts`). Everything
 * between the MIRROR markers is copied verbatim from the backend's
 * `convex/lib/credentialRedaction.ts` and pinned there as the
 * `credential-redaction` mirror pair. Edit it on the backend side first.
 */

export const REDACTED = "[REDACTED]";

// ── MIRROR: credential-redaction BEGIN ──
// Byte-identical in `sdk/src/contract/credential-redaction.ts`, so the SDK's
// local goal judge applies the same credential pass as the hosted one.
/**
 * Field names whose VALUE is a credential — the single source of truth for
 * BOTH consumers: the string scanner below (`pattern`, an ordered regex
 * alternation) and the structural sanitizer in `lib/evalIngestRedaction.ts`
 * (`name`, matched as an object key). Keeping one list is the point: log
 * redaction and persistence redaction cannot drift apart.
 *
 * `clientId` is deliberately absent — it is a public OAuth identifier, it is
 * what makes a redacted log still attributable to a server, and the SDK's
 * redactor omits it too. `tokenCount` and friends are likewise not credentials:
 * key matching is on the WHOLE normalized name, never a prefix.
 *
 * ORDER MATTERS for `pattern`: a regex alternation is tried left to right, so
 * every specific name precedes the generic one it contains
 * (`proxyAuthorization` before `authorization`, `setCookie` before `cookie`).
 */
const CREDENTIAL_FIELDS: ReadonlyArray<{ name: string; pattern: string }> = [
  { name: "accessToken", pattern: "access[_-]?token" },
  { name: "refreshToken", pattern: "refresh[_-]?token" },
  { name: "idToken", pattern: "id[_-]?token" },
  { name: "clientSecret", pattern: "client[_-]?secret" },
  { name: "apiKey", pattern: "api[_-]?key" },
  { name: "codeVerifier", pattern: "code[_-]?verifier" },
  { name: "proxyAuthorization", pattern: "proxy[_-]?authorization" },
  { name: "authorization", pattern: "authorization" },
  { name: "setCookie", pattern: "set[_-]?cookie" },
  { name: "cookie", pattern: "cookie" },
  { name: "privateKey", pattern: "private[_-]?key" },
  { name: "password", pattern: "password" },
  { name: "passwd", pattern: "passwd" },
  { name: "secret", pattern: "secret" },
  { name: "token", pattern: "token" },
];

/** Case-insensitive, `_`/`-`-insensitive comparison form for a field name. */
export function normalizeCredentialFieldName(key: string): string {
  return key.replace(/[_-]/g, "").toLowerCase();
}

const CREDENTIAL_FIELD_NAMES = new Set(
  CREDENTIAL_FIELDS.map((field) => normalizeCredentialFieldName(field.name))
);

/** The canonical credential field names, for tests and for documentation. */
export const CREDENTIAL_FIELD_NAME_LIST: readonly string[] =
  CREDENTIAL_FIELDS.map((field) => field.name);

/**
 * True when an object key names a credential — i.e. its VALUE is the secret,
 * whatever type that value has. Whole-name match, so `clientId`, `tokenCount`
 * and `secretsCount` are not credentials.
 */
export function isCredentialFieldName(key: string): boolean {
  return CREDENTIAL_FIELD_NAMES.has(normalizeCredentialFieldName(key));
}

const CREDENTIAL_FIELD = `(?:${CREDENTIAL_FIELDS.map(
  (field) => field.pattern
).join("|")})`;

/**
 * `name: "value"` / `name='value'` / `name=value`, with the name optionally
 * quoted. The leading lookbehind stands in for `\b`, which does not fire inside
 * a camelCase identifier. `&` terminates a value so redacting one query
 * parameter does not swallow the rest of the query string.
 */
const FIELD_ASSIGNMENT = new RegExp(
  `(?<![A-Za-z0-9])(["']?)(${CREDENTIAL_FIELD})\\1\\s*([:=])\\s*` +
    `("[^"]*"|'[^']*'|[^\\s,;&}\\)\\]]+)`,
  "gi"
);

const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
const AUTH_HEADER_LINE =
  /\b(authorization|proxy-authorization|cookie|set-cookie)\s*:\s*[^\r\n,}]*/gi;

/** Redact credential-shaped content from a single string. */
export function redactCredentialString(value: string): string {
  return value
    .replace(JWT, "[JWT_REDACTED]")
    .replace(
      AUTH_HEADER_LINE,
      (_match, header: string) => `${header}: ${REDACTED}`
    )
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(
      FIELD_ASSIGNMENT,
      (
        match: string,
        quote: string,
        field: string,
        separator: string,
        value: string
      ) => {
        // An earlier rule already redacted this one; matching it again would
        // wrap the placeholder in a second set of brackets.
        if (value.startsWith("[")) return match;
        const replacement = quote ? `${quote}${REDACTED}${quote}` : REDACTED;
        return `${quote}${field}${quote}${separator}${replacement}`;
      }
    );
}
// ── MIRROR: credential-redaction END ──
