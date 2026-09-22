/**
 * The single owner of OAuth trace redaction.
 *
 * Everything that decides "is this field a secret" or "what does a redacted
 * value look like" lives here, in the SDK, and both the SDK's trace projection
 * and the inspector's own trace collection import it. Before this module the
 * same policy existed in six places and the copies had already drifted — the
 * SDK's sensitive-field set omitted `state`, the client's included it, and the
 * SDK's error-string redactor mangled "Bearer token is expired" while the
 * client's did not.
 *
 * ## What this is NOT for
 *
 * Nothing here may be applied to data an OAuth flow CONSUMES. A redaction
 * sentinel is a non-empty string: it passes every truthiness check and is then
 * spent as a credential. That is #3865, and the factory's executor guard exists
 * to make it loud. Redaction is a property of DISPLAY and PERSISTENCE, applied
 * once, at projection time.
 *
 * ## Telemetry is deliberately separate
 *
 * `redactForTelemetry` (`src/telemetry-redaction.ts`) over-redacts on purpose and is
 * length-capped for Sentry. Merging it with the display redactor would either
 * make traces useless or make telemetry leaky.
 */

/**
 * Field names whose VALUE is a secret wherever it appears — as an object key,
 * a header, or a query parameter.
 *
 * `state` is here on purpose. It is not a bearer credential, but a still-live
 * `state` is the CSRF correlation secret for an in-flight authorization: an
 * attacker who learns it can complete the flow with their own code. That it
 * also travels in an authorization URL does not make it publishable — the URL
 * is transient, a persisted or copied trace is not. Diagnostics that need to
 * talk about `state` use `describeOAuthStateMatch` below, which reports
 * presence and match rather than the nonce.
 */
export const OAUTH_TRACE_SENSITIVE_FIELD_NAMES: ReadonlySet<string> = new Set([
  "access_token",
  "refresh_token",
  "id_token",
  "client_secret",
  "code",
  "code_verifier",
  "authorization_code",
  "authorization",
  "state",
  "cookie",
  "set_cookie",
  "api_key",
]);

const SENSITIVE_HEADER_PATTERNS = [
  /^authorization$/i,
  /^proxy-authorization$/i,
  /^cookie$/i,
  /^set-cookie$/i,
  /^x-api-key$/i,
  /^api-key$/i,
  /^apikey$/i,
  /^x-auth-token$/i,
  /^x-csrf-token$/i,
  /^x-session-token$/i,
  /^x-access-token$/i,
  /^x-refresh-token$/i,
  /^x-client-secret$/i,
  /^x-credential$/i,
];

function normalizeSensitiveKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toLowerCase();
}

/**
 * Names that DESCRIBE a credential capability rather than carry one.
 *
 * The heuristic below fires on any name containing a `token`/`secret`/`auth`
 * segment, which is right for an unbounded name space and wrong for the OAuth
 * metadata documents a trace exists to show: `token_endpoint`, `token_type`,
 * `token_endpoint_auth_methods_supported`, `id_token_signing_alg_values_supported`.
 * Redacting those would empty out the discovery view without protecting
 * anything — none of them is a value an attacker can spend.
 *
 * Matched on the normalized name's suffix, because that is what separates "this
 * IS the thing" from "this describes the thing".
 */
const DESCRIPTIVE_NAME_SUFFIXES = [
  "_type",
  "_types",
  "_endpoint",
  "_endpoints",
  "_supported",
  "_method",
  "_methods",
  "_uri",
  "_uris",
  "_url",
  "_urls",
  "_alg",
  "_algs",
  "_values",
  "_in",
];

function isDescriptiveName(normalized: string): boolean {
  return DESCRIPTIVE_NAME_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/**
 * The one name policy, shared by structured fields, headers, and query params.
 *
 * These used to disagree: headers and query parameters applied the
 * `token|secret|password|credential|cookie|auth` heuristic and structured
 * fields did not, so a response field named `session_token` was redacted in a
 * URL and emitted raw in a JSON body. Where a value appears is not a property
 * of how secret it is.
 */
function matchesSensitiveName(normalized: string): boolean {
  if (OAUTH_TRACE_SENSITIVE_FIELD_NAMES.has(normalized)) {
    return true;
  }
  if (isDescriptiveName(normalized)) {
    return false;
  }
  return (
    /(^|_)(token|secret|password|credential|cookie|auth)(_|$)/.test(normalized) ||
    /(^|_)api_?key(_|$)/.test(normalized)
  );
}

export function isSensitiveTraceFieldName(key: string): boolean {
  return matchesSensitiveName(normalizeSensitiveKey(key));
}

export function isSensitiveHeaderName(key: string): boolean {
  const normalized = normalizeSensitiveKey(key);
  return (
    matchesSensitiveName(normalized) ||
    SENSITIVE_HEADER_PATTERNS.some((pattern) => pattern.test(key))
  );
}

export function isSensitiveQueryParamName(key: string): boolean {
  return matchesSensitiveName(normalizeSensitiveKey(key));
}

/**
 * The display form of a redacted value: enough of the ends to correlate two
 * sightings of the same credential, never enough to use one.
 *
 * The exact shapes produced here — `[redacted]` and `abcd...[redacted]...yz` —
 * are what the factory's executor guard recognizes when one of them shows up
 * where a live credential belongs.
 */
export function redactSensitiveTraceValue(value: unknown): string {
  if (typeof value !== "string") {
    return "[redacted]";
  }

  if (value.length <= 8) {
    return "[redacted]";
  }

  return `${value.slice(0, 4)}...[redacted]...${value.slice(-2)}`;
}

// ---------------------------------------------------------------------------
// Error strings
// ---------------------------------------------------------------------------

/**
 * Credential-ish parameter names for free-form text.
 *
 * Wider than the structured field set because an error string has no schema:
 * whatever the server chose to echo arrives as prose, and the parameter NAME is
 * the diagnostic, not its value.
 */
const CREDENTIAL_PARAM_NAMES =
  "client_secret|access_token|refresh_token|id_token|code_verifier|code|assertion|password|api[-_]?key|token|secret|state";

/**
 * Built once from the module-level literal above rather than per call. The
 * alternations are static and unambiguous; constructing them on every
 * projection was pure waste on a render path.
 */
const CREDENTIAL_QUERY_PARAM_RE = new RegExp(
  `(^|[^\\w-])((?:[\\w-]*[_-])?(?:${CREDENTIAL_PARAM_NAMES}))=[^&\\s"'<>]+`,
  "gi",
);
const CREDENTIAL_JSON_FIELD_NAME =
  `(?:(?:[\\w-]*[_-])?(?:${CREDENTIAL_PARAM_NAMES}))`;
const CREDENTIAL_JSON_FIELD_RE = new RegExp(
  `("${CREDENTIAL_JSON_FIELD_NAME}"\\s*:\\s*)"(?:\\\\.|[^"\\\\])*"`,
  "gi",
);
const CREDENTIAL_JSON_FIELD_UNTERMINATED_RE = new RegExp(
  `("${CREDENTIAL_JSON_FIELD_NAME}"\\s*:\\s*)"(?:\\\\[\\s\\S]?|[^"\\\\])*$`,
  "gi",
);

/** Default output length of a redacted message. Exported so a test can
 * derive its boundary inputs instead of hardcoding a number derived from it. */
export const MAX_REPORTED = 500;

/**
 * How much raw input the redactors are allowed to scan.
 *
 * The cap has to come BEFORE the replace chain — an upstream body can be
 * megabytes, and four global regexes over it would copy the whole thing four
 * times on a render path. It is deliberately wider than `MAX_REPORTED` so the
 * redactors still see the context around anything that survives to the output.
 */
export const MAX_SCANNED = 4_000;

/**
 * Names that can ONLY be a credential, so the value is redactable after a bare
 * `:` and not just a `=`.
 *
 * An `error_description` is prose. A server echoing request context back
 * writes `access_token: <value>` at least as often as `access_token=<value>`,
 * and redacting only the query-string form leaves the credential in persisted
 * traces. The colon form cannot use the full `CREDENTIAL_PARAM_NAMES` list,
 * though: `code`, `token`, `secret` and `state` are ordinary English words in
 * an error message, and "status code: 401" must survive intact. This is the
 * same split the pre-consolidation SDK redactor drew.
 *
 * `[-_]?` rather than a literal `_` so the camelCase spellings a JSON API
 * actually emits (`clientSecret`) match under the `i` flag.
 */
const UNAMBIGUOUS_CREDENTIAL_NAMES =
  "client[-_]?secret|access[-_]?token|refresh[-_]?token|id[-_]?token|code[-_]?verifier";

const CREDENTIAL_ASSIGNMENT_RE = new RegExp(
  `\\b((?:[\\w-]*[_-])?(?:${UNAMBIGUOUS_CREDENTIAL_NAMES}))(\\s*[:=]\\s*)("(?:\\\\.|[^"\\\\])*"|[^&\\s"'<>,;]+)`,
  "gi",
);

/**
 * Is `value` — the token after a `Bearer`/`Basic` scheme word — a credential,
 * or is it part of the sentence the scheme word happens to start?
 *
 * The judgement, not just the rule: `\b(bearer|basic)\s+\w+` turns the very
 * common "Bearer token is expired" into "Bearer [redacted] is expired",
 * destroying the diagnostic word the redactors promise to keep — and it turns
 * the hosted 401's own copy, "Bearer token required", into nonsense the user
 * cannot act on. Keying on punctuation-or-length gets prose right but misses
 * short opaque credentials — `Basic dXNlcjpwYXNz` is a valid header value with
 * neither. So invert the test and ask whether the value could be a WORD
 * instead: anything carrying mixed case, a digit, or base64url punctuation is
 * credential-shaped, and a plain lowercase run is vocabulary.
 *
 * Exported because the display redactor below is not the only place that has
 * to make this call — telemetry redaction over-redacts by design and stays
 * separate, but "is this a credential or a noun" is one question with one
 * answer, and the copies of it had already drifted.
 */
export function isCredentialShapedAuthValue(value: string): boolean {
  // Trailing sentence punctuation belongs to the prose, not the value.
  const core = value.replace(/[.,;:!?)\]}]+$/, "");
  return !/^[a-z]{1,20}$/.test(core);
}

/** Replacer for a bare `Bearer`/`Basic <value>` with no header context. */
function redactBareSchemeMatch(
  match: string,
  scheme: string,
  gap: string,
  value: string
): string {
  return isCredentialShapedAuthValue(value)
    ? `${scheme}${gap}[redacted]`
    : match;
}

/**
 * Redact credential-shaped substrings from a free-form error message.
 *
 * Error strings interpolate whatever the server put in `error` /
 * `error_description`, and MCPJam is routinely pointed at half-built servers
 * that echo request context back into error bodies. Every shape a credential
 * plausibly arrives in is covered:
 *
 *   1. URL userinfo, with or without a scheme (`https://u:p@h`, `u:p@h`)
 *   2. credential-ish query/form parameters, by name
 *   3. `Authorization: Bearer|Basic <value>` echoed from a request
 *   4. JSON credential fields (`"client_secret": "..."`)
 *
 * Then a length cap, because an upstream body can be arbitrarily large.
 *
 * Deliberately over-redacts, with one hard constraint: it must not destroy the
 * diagnostic vocabulary it exists to preserve. "Bearer token is expired" is a
 * description, not a credential, and has to survive intact — which is why rule
 * 3b matches only credential-SHAPED values. The result also stays a
 * human-readable string; an error message must never be reshaped into an
 * object.
 */
export function sanitizeTraceErrorMessage(
  message: string,
  options: {
    /**
     * Output cap. Defaults to {@link MAX_REPORTED}, which suits one error
     * message. A caller with a genuinely multi-line payload (a stack trace)
     * raises it rather than redacting line by line — splitting first separates
     * a JSON credential's key from its value and defeats rule 4.
     */
    maxLength?: number;
    /** Scan cap. Raise alongside `maxLength`; see {@link MAX_SCANNED}. */
    maxScanned?: number;
  } = {},
): string {
  const maxScanned = options.maxScanned ?? MAX_SCANNED;
  const maxReported = options.maxLength ?? MAX_REPORTED;
  const truncated = message.length > maxScanned;
  const bounded = truncated ? message.slice(0, maxScanned) : message;

  const redacted = bounded
    // 1a. scheme://user:pass@host. Greedy up to the LAST `@` of the
    // authority: `@` is legal inside a password, so
    // `https://user:secret@part@host` has userinfo `user:secret@part`, and
    // stopping at the first `@` would report half the password.
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi, "$1[redacted]@")
    // 1b. bare user:pass@host (no scheme), same greediness.
    .replace(/(^|[\s(<"'])[^\s/@:]+:[^\s/]+@(?=[\w.-]+)/g, "$1[redacted]@")
    // 2a. Free-form `access_token: …` / `clientSecret = …`, quoted or bare.
    // Runs before 2 so the unambiguous names get the colon form too; a
    // quoted KEY (`"access_token": "…"`) does not match here and is left to
    // rule 4, which keeps the JSON shape intact.
    .replace(
      CREDENTIAL_ASSIGNMENT_RE,
      (_match, name: string, separator: string, value: string) =>
        `${name}${separator}${value.startsWith('"') ? '"[redacted]"' : "[redacted]"}`,
    )
    // 2. ?client_secret=… / &token=… / &state=…
    //
    // NOT `\b(name)=`: `_` is a word character, so there is no boundary inside
    // `user_access_token=` and the value would stay raw. Match an optional
    // vendor prefix instead, anchored on a genuine non-name character.
    .replace(CREDENTIAL_QUERY_PARAM_RE, "$1$2=[redacted]")
    // 3a. An echoed `Authorization:` header — redact whatever follows.
    .replace(
      /\b((?:proxy-)?authorization\s*[:=]\s*)(bearer|basic)\s+\S+/gi,
      "$1$2 [redacted]",
    )
    // 3b. A bare `Bearer <value>` with no header context. This one must not
    // fire on prose — see `isCredentialShapedAuthValue`, which owns that call.
    .replace(/\b(bearer|basic)(\s+)(\S+)/gi, redactBareSchemeMatch)
    // 4. "client_secret": "…" — `(?:\\.|[^"\\])*` rather than `[^"]*`, or an
    // escaped quote inside the value ends the match early and leaves the
    // secret's tail in the report.
    .replace(CREDENTIAL_JSON_FIELD_RE, '$1"[redacted]"');

  // Patterns 1b/2/3 all match to end-of-string, so a value the cap cut in half
  // is still redacted. The JSON and scheme-userinfo forms need a closing
  // delimiter, so cutting mid-value would leave a raw prefix — close those two
  // here, and only when the cap actually fired, so an ordinary message that
  // merely ends in a URL keeps its hostname.
  const tailGuarded = truncated
    ? redacted
        // Escape-aware like the terminated form above, or an unterminated
        // value containing `\"` stops the match at that quote and leaks its
        // tail.
        .replace(CREDENTIAL_JSON_FIELD_UNTERMINATED_RE, '$1"[redacted]')
        .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*$/gi, "$1[redacted]")
    : redacted;

  return tailGuarded.slice(0, maxReported);
}

// ---------------------------------------------------------------------------
// Structured values
// ---------------------------------------------------------------------------

export type OAuthRequestFields = Record<string, string>;

/**
 * Parse a request/response body into flat string fields, so a form-encoded or
 * JSON body can be redacted by field name rather than by regex.
 */
export function parseOAuthRequestFields(
  body: unknown,
): OAuthRequestFields | undefined {
  if (!body) return undefined;

  if (typeof body === "string") {
    const trimmed = body.trim();
    if (!trimmed) {
      return undefined;
    }

    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        const parsed = JSON.parse(trimmed);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          !Array.isArray(parsed)
        ) {
          const entries = Object.entries(parsed).flatMap(([key, value]) => {
            if (typeof value === "string") {
              return [[key, value] as const];
            }
            if (typeof value === "number" || typeof value === "boolean") {
              return [[key, String(value)] as const];
            }
            return [];
          });
          return entries.length > 0 ? Object.fromEntries(entries) : undefined;
        }
      } catch {
        // Fall through to URLSearchParams parsing.
      }
    }

    const params = new URLSearchParams(trimmed);
    const entries = Object.fromEntries(params.entries());
    return Object.keys(entries).length > 0 ? entries : undefined;
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return undefined;
  }

  const entries = Object.entries(body).flatMap(([key, value]) => {
    if (typeof value === "string") {
      return [[key, value] as const];
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return [[key, String(value)] as const];
    }
    return [];
  });

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * Whether parsed fields actually look like a form body rather than prose that
 * happened to contain an `=`.
 *
 * `URLSearchParams` never fails: it turns
 * `"rejected: access_token=ntn_live"` into the single field
 * `{"rejected: access_token": "ntn_live"}`, whose key is not in the sensitive
 * set — so reshaping prose into "structured fields" used to LOSE redaction that
 * the plain-string path would have applied. Requiring parameter-shaped keys
 * keeps the nicer structured rendering for real bodies and sends everything
 * else to the error-string redactor.
 */
function looksLikeRequestFields(fields: OAuthRequestFields): boolean {
  return Object.keys(fields).every(
    // No `:` — it is not legal in an OAuth parameter name, and allowing it lets
    // `rejected:access_token=…` parse as one "field" whose key is in no
    // sensitive set, losing the redaction the string path would have applied.
    (key) => key.length <= 64 && /^[A-Za-z0-9_.\-[\]]+$/.test(key),
  );
}

/**
 * How deep a URL nested inside a query parameter is followed.
 *
 * A redirect chain can nest a handful of times legitimately; past that the
 * value is not something a trace reader is going to interpret anyway, so it is
 * cheaper to redact it than to keep parsing.
 */
const MAX_NESTED_URL_DEPTH = 3;

/**
 * Sanitize a query parameter VALUE whose name was not itself sensitive.
 *
 * `isDescriptiveName` exempts `*_url`, `*_uri` and `*_endpoint` so the
 * discovery view keeps its metadata, but that exemption is a statement about
 * the name, not about what the name points at. `session_token_url`,
 * `password_uri` and `client_secret_endpoint` all pass the exemption while
 * carrying a URL that can have `access_token=…` in its own query string.
 */
function sanitizeNestedQueryValue(value: string, depth: number): string {
  if (/^https?:\/\//i.test(value)) {
    return depth >= MAX_NESTED_URL_DEPTH
      ? "[redacted]"
      : sanitizeOAuthUrl(value, depth + 1);
  }
  // Not a URL, but a decoded value can still carry an inline assignment.
  return value.replace(CREDENTIAL_QUERY_PARAM_RE, "$1$2=[redacted]");
}

export function sanitizeOAuthUrl(rawUrl: string, depth = 0): string {
  try {
    const url = new URL(rawUrl);
    // Userinfo round-trips through `toString()`, so the parse-SUCCESS branch
    // has to strip it explicitly. Only the catch branch reaches
    // `sanitizeTraceErrorMessage`, whose rule 1a covers it.
    url.username = "";
    url.password = "";

    // Rebuilt in order, and only assigned back when something actually
    // changed: `url.search = …` re-serializes the whole query, which would
    // churn every golden containing an untouched URL.
    let changed = false;
    const rebuilt = new URLSearchParams();
    for (const [key, value] of url.searchParams.entries()) {
      const next = isSensitiveQueryParamName(key)
        ? "[redacted]"
        : sanitizeNestedQueryValue(value, depth);
      changed ||= next !== value;
      rebuilt.append(key, next);
    }
    if (changed) {
      url.search = rebuilt.toString();
    }

    if (url.hash) {
      url.hash = "#[redacted]";
    }
    return url.toString();
  } catch {
    return sanitizeTraceErrorMessage(rawUrl);
  }
}

function sanitizeOAuthTraceString(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return sanitizeOAuthUrl(trimmed);
  }

  const looksStructured =
    trimmed.includes("=") ||
    trimmed.includes("&") ||
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"));
  if (looksStructured) {
    const parsed = parseOAuthRequestFields(trimmed);
    if (parsed && looksLikeRequestFields(parsed)) {
      return sanitizeOAuthTraceValue(parsed);
    }
  }

  return sanitizeTraceErrorMessage(trimmed);
}

export function sanitizeOAuthTraceValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeOAuthTraceValue(item));
  }

  if (typeof value === "string") {
    return sanitizeOAuthTraceString(value);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => {
      if (isSensitiveTraceFieldName(key)) {
        return [key, redactSensitiveTraceValue(entryValue)];
      }
      return [key, sanitizeOAuthTraceValue(entryValue)];
    }),
  );
}

function sanitizeOAuthHeaderValue(value: string): string {
  const sanitized = sanitizeOAuthTraceString(value);
  if (typeof sanitized === "string") {
    return sanitized;
  }
  return redactSensitiveTraceValue(value);
}

export function sanitizeOAuthHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => {
      if (isSensitiveHeaderName(key)) {
        return [key, redactSensitiveTraceValue(value)];
      }
      return [key, sanitizeOAuthHeaderValue(value)];
    }),
  );
}

// ---------------------------------------------------------------------------
// `state` diagnostics
// ---------------------------------------------------------------------------

export interface OAuthStateMatchDiagnostics {
  /** Whether the authorization response carried a `state` at all. */
  statePresent: boolean;
  /**
   * Whether it equals the issued value. `undefined` when there is nothing to
   * compare against (no issued state recorded).
   */
  stateMatched?: boolean;
}

/**
 * The publishable form of a `state` comparison.
 *
 * Everything a reader needs to debug a CSRF-check failure — did the server send
 * one, and did it match — without the nonce itself. Constant-time comparison is
 * not attempted: both values are already in this process, and the check that
 * matters (the machine's own) happens elsewhere.
 */
export function describeOAuthStateMatch(input: {
  issuedState?: string | null;
  callbackState?: string | null;
}): OAuthStateMatchDiagnostics {
  const statePresent =
    typeof input.callbackState === "string" && input.callbackState.length > 0;

  if (!input.issuedState) {
    return { statePresent };
  }

  return {
    statePresent,
    stateMatched: statePresent && input.callbackState === input.issuedState,
  };
}
