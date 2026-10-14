/**
 * The registry: every route whose path, query or fragment carries a secret,
 * the query and fragment keys that are secrets on any URL, and the
 * placeholder a secret becomes. `../credential-urls.ts` describes the whole.
 */

/** Where a route's secret sits. */
export type CredentialLocation = "path" | "query" | "fragment";

/** Who loads the URL: a page the browser shows, or an API the client calls. */
export type CredentialScope = "page" | "api";

/**
 * How long the secret is good for. Decides what a leak costs:
 *
 *  - `permanent`     — valid until someone revokes it (share links).
 *  - `expiring`      — valid for a bounded time (signed media links).
 *  - `single_use`    — consumed by its first use (handoff claims).
 *  - `one_time_code` — an OAuth-style code exchanged within minutes.
 *  - `session`       — valid for the session it authenticates.
 */
export type CredentialTtl =
  "permanent" | "expiring" | "single_use" | "one_time_code" | "session";

export interface CredentialRoute {
  /** Stable id: metrics, docs and the leak monitor key on it. */
  id: string;
  /**
   * Route template. `:name` is one segment, a trailing `*` is any suffix
   * (including none). Matched against the START of a pathname.
   */
  pattern: string;
  /**
   * The secret. For `path`, the `:param` in `pattern` that holds it; for
   * `query`/`fragment`, the key (every key listed is also in
   * `SECRET_PARAM_KEYS`, so it is scrubbed on any URL).
   */
  secretParam: string;
  secretIn: CredentialLocation;
  scope: CredentialScope;
  ttl: CredentialTtl;
  /**
   * Values of the secret segment that are app vocabulary, not secrets:
   * `/user-testing/<id>/edit` is the scenario editor, and
   * `/connect/server/request/<id>` carries nothing secret.
   */
  reserved?: readonly string[];
  /** What it is, for the docs and the reviewer. */
  note: string;
}

export const CREDENTIAL_ROUTES = [
  // ── Pages ──────────────────────────────────────────────────────────────
  {
    id: "score-results",
    pattern: "/results/:runToken",
    secretParam: "runToken",
    secretIn: "path",
    scope: "page",
    ttl: "permanent",
    note: "Score run result link (app and score.mcpjam.com). The token is the only access control.",
  },
  {
    id: "bench-results",
    pattern: "/bench/results/:secret",
    secretParam: "secret",
    secretIn: "path",
    scope: "page",
    ttl: "permanent",
    note: "Connector Bench result link. A hex secret that would otherwise pass for an id.",
  },
  {
    id: "conformance-shared",
    pattern: "/conformance/shared/:token",
    secretParam: "token",
    secretIn: "path",
    scope: "page",
    ttl: "permanent",
    note: "Shared conformance report (HMAC token).",
  },
  {
    id: "evals-shared",
    pattern: "/evals/shared/:token",
    secretParam: "token",
    secretIn: "path",
    scope: "page",
    ttl: "permanent",
    note: "Shared eval report.",
  },
  {
    id: "tester-link",
    pattern: "/user-testing/:slug/:token",
    secretParam: "token",
    secretIn: "path",
    scope: "page",
    ttl: "permanent",
    reserved: ["edit"],
    note: "Published study's tester link. `/user-testing/<id>/edit` is the editor, not a link.",
  },
  {
    id: "tester-link-legacy",
    pattern: "/chatbox/:slug/:token",
    secretParam: "token",
    secretIn: "path",
    scope: "page",
    ttl: "permanent",
    note: "Pre-rename tester link shape. No longer minted, still in old emails and histories.",
  },
  {
    id: "server-connection-claim",
    pattern: "/connect/server/:handoffToken",
    secretParam: "handoffToken",
    secretIn: "path",
    scope: "page",
    ttl: "single_use",
    reserved: ["request"],
    note: "Server-connection handoff. Traded for a cookie, then replaced by /connect/server/request/<id>.",
  },
  {
    id: "mcp-oauth-callback",
    pattern: "/oauth/callback*",
    secretParam: "code",
    secretIn: "query",
    scope: "page",
    ttl: "one_time_code",
    note: "MCP server OAuth callback (and its debugger variants): `code` and `state`.",
  },
  {
    id: "github-install-callback",
    pattern: "/settings/integrations/github/callback",
    secretParam: "code",
    secretIn: "query",
    scope: "page",
    ttl: "one_time_code",
    note: "GitHub App install callback: `code` and `state`.",
  },
  {
    id: "workos-callback",
    pattern: "/callback",
    secretParam: "code",
    secretIn: "query",
    scope: "page",
    ttl: "one_time_code",
    note: "WorkOS AuthKit sign-in callback. authkit-js consumes the code; the URL is scrubbed everywhere.",
  },
  {
    id: "local-access-link",
    pattern: "/*",
    secretParam: "token",
    secretIn: "fragment",
    scope: "page",
    ttl: "permanent",
    note: "Local Inspector access link `#token=`. Consumed from the fragment before telemetry starts.",
  },
  // ── API ────────────────────────────────────────────────────────────────
  {
    id: "api-score-run",
    pattern: "/api/web/score/runs/:token",
    secretParam: "token",
    secretIn: "path",
    scope: "api",
    ttl: "permanent",
    note: "Score result read behind /results/<token>.",
  },
  {
    id: "api-bench-results",
    pattern: "/api/web/bench/results/:secret",
    secretParam: "secret",
    secretIn: "path",
    scope: "api",
    ttl: "permanent",
    note: "Bench result read behind /bench/results/<secret>.",
  },
  {
    id: "api-conformance-shared",
    pattern: "/api/web/conformance-shared/:token",
    secretParam: "token",
    secretIn: "path",
    scope: "api",
    ttl: "permanent",
    note: "Legacy conformance share read behind /conformance/shared/<token>.",
  },
  {
    id: "api-session-token-query",
    pattern: "/api/*",
    secretParam: "_token",
    secretIn: "query",
    scope: "api",
    ttl: "session",
    note: "Session token on SSE routes (EventSource cannot send headers).",
  },
  {
    id: "signed-artifact-link",
    pattern: "/*",
    secretParam: "t",
    secretIn: "query",
    scope: "api",
    ttl: "expiring",
    note: "Signed artifact/media link `?t=` minted by the backend.",
  },
] as const satisfies readonly CredentialRoute[];

export type CredentialRouteId = (typeof CREDENTIAL_ROUTES)[number]["id"];

/** Placeholder a secret is replaced with. Never matches a credential pattern. */
export const CREDENTIAL_PLACEHOLDER = "[redacted]";

/** The placeholder percent-encoded, as `encodeURIComponent` writes it. */
export const ENCODED_PLACEHOLDER = /%5Bredacted%5D/gi;

/**
 * Query and fragment keys whose value is a credential on ANY URL — ours, an
 * OAuth provider's, a presigned bucket's. Lowercase; compared
 * case-insensitively. The union of the conformance-report list
 * (`sdk/src/conformance-redaction.ts`), the session-token params the server
 * already scrubbed from its logs, and the SSO/presigned-URL families.
 */
export const SECRET_PARAM_KEYS: ReadonlySet<string> = new Set([
  // OAuth / OIDC
  "code",
  "state",
  "access_token",
  "refresh_token",
  "id_token",
  "client_secret",
  "code_verifier",
  "assertion",
  "client_assertion",
  // Our own session and link tokens
  "token",
  "_token",
  "t",
  "k",
  // API keys and passwords
  "api_key",
  "apikey",
  "key",
  "password",
  // Bearer tokens and one-time passcodes; the relay's
  // `CREDENTIAL_QUERY_KEYS` (`shared/telemetry-privacy.ts`) already strips them
  "jwt",
  "auth",
  "authorization",
  "otp",
  // Signed URLs
  "signature",
  "sig",
  // SSO
  "ticket",
  "samlresponse",
  "samlrequest",
  "relaystate",
]);

/**
 * Key families no enumeration can cover: presigned cloud-storage URLs
 * (`X-Amz-Signature`, `X-Amz-Credential`, `X-Goog-Signature`, …) and
 * vendor-prefixed token names (`x_vendor_access_token`).
 */
const SECRET_PARAM_KEY_PATTERN =
  /^(?:x-amz-|x-goog-)|(?:token|secret|password|signature|apikey|api_key|credential)$/i;

/** Whether a query/fragment key's value is a credential. */
export function isSecretParamKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  return (
    SECRET_PARAM_KEYS.has(normalized) ||
    SECRET_PARAM_KEY_PATTERN.test(normalized)
  );
}
