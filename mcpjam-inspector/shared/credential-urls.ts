/**
 * Credential URLs: the ONE place that knows which URLs carry a secret, and
 * the one scrubber every telemetry exit applies.
 *
 * Some of our URLs are bearer credentials. The token in `/results/<token>` is
 * the only thing between a private run and anyone holding the link; an OAuth
 * callback's `?code=` is a one-time authorization code; `?_token=` is a
 * session. Every telemetry sink sees URLs — PostHog's `$current_url`, Sentry's
 * transaction names and breadcrumbs, replay meta events, server log lines,
 * the relay's forwarded payloads — so each one has to agree on what a
 * credential URL looks like. They used to keep four lists, and the lists
 * disagreed. Now they read this one.
 *
 * Three things are defined here:
 *
 *  - `CREDENTIAL_ROUTES`: every route whose path, query or fragment carries a
 *    secret, with where the secret sits and how long it lives. CI fails when
 *    a route parameter that looks secret (`/token|secret|code|key|sig|cred/i`)
 *    is not registered here or allow-listed with a reason
 *    (`client/src/lib/__tests__/credential-route-completeness.test.ts` and
 *    `server/routes/web/__tests__/credential-route-completeness.test.ts`).
 *  - `SECRET_PARAM_KEYS`: query/fragment keys whose VALUE is a credential
 *    wherever they appear, on any URL, ours or not.
 *  - The scrubbers: `scrubCredentialUrl` (one URL), `scrubCredentialsInText`
 *    (URLs and credential paths anywhere inside free text), and
 *    `scrubTelemetryValue` (any JSON-ish value, keys included). Every sink
 *    runs the last one.
 *
 * Fail closed: the scrubbers never throw. A URL that cannot be parsed is
 * scrubbed as text; a value the walker cannot finish is reported as a failure
 * so the caller can drop the URL-bearing fields or the whole event
 * (`scrubTelemetryEvent`). Nothing half-scrubbed is ever returned as clean.
 *
 * Pure — no DOM, no Node APIs, no SDK — so the browser, the server, Electron
 * main and the relay all import it. Regexes avoid lookbehind: older Safari
 * fails to PARSE a module that contains one, which would take the app down.
 *
 * `docs/session-replay-masking.md` and the public telemetry-privacy page
 * describe the guarantees this module carries.
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

// ── Route matching ─────────────────────────────────────────────────────

interface CompiledRoute {
  route: CredentialRoute;
  /** Anchored at the start of a pathname. */
  anchored: RegExp;
  /** 1-based group of the secret segment, for `path` routes. */
  secretGroup: number;
  /** The literal path before the first parameter. */
  staticPrefix: string;
  /** Segment names, in order, for `path` routes. */
  paramNames: string[];
}

/**
 * A path segment. Never one that starts with `:` — that is a route template's
 * parameter (`/results/:runToken`), not a value, and templates are exactly
 * what the scrubbers replace secrets WITH.
 */
const SEGMENT = "((?!:)[^/?#]+)";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

function compileRoute(route: CredentialRoute): CompiledRoute {
  const splat = route.pattern.endsWith("*");
  const body = splat ? route.pattern.slice(0, -1) : route.pattern;
  const paramNames: string[] = [];
  const source = body
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        paramNames.push(segment.slice(1));
        return SEGMENT;
      }
      return escapeRegex(segment);
    })
    .join("/");
  const tail = splat ? "" : "(?=/|$)";
  const firstParam = body.indexOf(":");
  return {
    route,
    anchored: new RegExp(`^${source}${tail}`),
    secretGroup:
      route.secretIn === "path" ? paramNames.indexOf(route.secretParam) + 1 : 0,
    staticPrefix: firstParam === -1 ? body : body.slice(0, firstParam),
    paramNames,
  };
}

const COMPILED_ROUTES: readonly CompiledRoute[] = (
  CREDENTIAL_ROUTES as readonly CredentialRoute[]
).map(compileRoute);

const PATH_ROUTES = COMPILED_ROUTES.filter(
  (compiled) => compiled.route.secretIn === "path",
);

/** Query-secret routes with a concrete path: the callbacks. */
const CALLBACK_ROUTES = COMPILED_ROUTES.filter(
  (compiled) =>
    compiled.route.secretIn === "query" &&
    compiled.route.scope === "page" &&
    compiled.route.pattern !== "/*",
);

export interface CredentialRouteMatch {
  route: CredentialRoute;
  /** Every `:param` in the template, decoded where possible. */
  params: Record<string, string>;
  /** The secret's raw (undecoded) text, for `path` routes. */
  secret?: string;
  /** Index range of the secret segment within the pathname. */
  secretStart?: number;
  secretEnd?: number;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The path-secret route a pathname belongs to, if any. A reserved value in
 * the secret segment (`edit`, `request`) is not a match.
 */
export function matchCredentialPath(
  pathname: string,
): CredentialRouteMatch | null {
  for (const compiled of PATH_ROUTES) {
    const match = compiled.anchored.exec(pathname);
    if (!match) continue;
    const secret = match[compiled.secretGroup];
    if (secret === undefined) continue;
    const reserved = compiled.route.reserved;
    if (reserved?.includes(safeDecode(secret).toLowerCase())) continue;
    if (secret === CREDENTIAL_PLACEHOLDER) continue;
    const params: Record<string, string> = {};
    compiled.paramNames.forEach((name, index) => {
      params[name] = safeDecode(match[index + 1] ?? "");
    });
    // The secret is the template's LAST group up to this point, so it ends
    // where the match ends minus anything after it in the template — which
    // is nothing, because every registered secret is the final segment.
    const secretEnd = match[0].length;
    return {
      route: compiled.route,
      params,
      secret,
      secretStart: secretEnd - secret.length,
      secretEnd,
    };
  }
  return null;
}

function matchCallbackPath(pathname: string): CredentialRoute | null {
  for (const compiled of CALLBACK_ROUTES) {
    if (compiled.anchored.test(pathname)) return compiled.route;
  }
  return null;
}

/** A registered route by id. */
export function credentialRoute(id: CredentialRouteId): CredentialRoute {
  const route = (CREDENTIAL_ROUTES as readonly CredentialRoute[]).find(
    (entry) => entry.id === id,
  );
  if (!route) throw new Error(`unknown credential route ${id}`);
  return route;
}

/**
 * The template a credential pathname belongs to (`/results/:runToken`), or
 * `null` when the pathname carries no path secret. Sentry transaction names
 * and log lines use it so the secret never becomes a name.
 */
export function credentialRouteTemplate(pathname: string): string | null {
  const match = matchCredentialPath(pathname);
  if (match) return match.route.pattern;
  return null;
}

// ── Query and fragment ─────────────────────────────────────────────────

/** Whether a `?a=b&c=d` / `#a=b` string has any secret key. */
function hasSecretKey(params: string): boolean {
  const body = params.replace(/^[?#]/, "");
  if (!body) return false;
  return body.split(/[&;]/).some((pair) => {
    const eq = pair.indexOf("=");
    const key = safeDecode(eq === -1 ? pair : pair.slice(0, eq));
    return key !== "" && isSecretParamKey(key);
  });
}

/**
 * Scrub a `key=value&…` string (no leading `?`/`#`), keeping its spelling:
 * secret keys get the placeholder, other values are scrubbed as text (a
 * `redirect_uri` can itself carry a credential URL).
 */
function scrubParamString(body: string): string {
  return body
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq === -1) return pair;
      const rawKey = pair.slice(0, eq);
      const rawValue = pair.slice(eq + 1);
      if (isSecretParamKey(safeDecode(rawKey.replace(/\+/g, " ")))) {
        return rawValue === "" ? pair : `${rawKey}=${CREDENTIAL_PLACEHOLDER}`;
      }
      const decoded = safeDecode(rawValue.replace(/\+/g, " "));
      const scrubbed = scrubCredentialsInText(decoded);
      return scrubbed === decoded
        ? pair
        : `${rawKey}=${encodeURIComponent(scrubbed)}`;
    })
    .join("&");
}

function scrubPathname(pathname: string): string {
  const match = matchCredentialPath(pathname);
  if (!match || match.secretStart === undefined) return pathname;
  return `${pathname.slice(0, match.secretStart)}${CREDENTIAL_PLACEHOLDER}${pathname.slice(match.secretEnd)}`;
}

function scrubFragment(fragment: string): string {
  // `#/results/<token>` — the legacy hash router puts a path here.
  if (fragment.startsWith("/")) {
    const end = fragment.search(/[?#]/);
    const path = end === -1 ? fragment : fragment.slice(0, end);
    const rest = end === -1 ? "" : fragment.slice(end);
    const scrubbedRest =
      rest.startsWith("?") || rest.startsWith("#")
        ? `${rest[0]}${scrubParamString(rest.slice(1))}`
        : rest;
    return `${scrubPathname(path)}${scrubbedRest}`;
  }
  if (fragment.includes("=")) return scrubParamString(fragment);
  return fragment;
}

// ── One URL ────────────────────────────────────────────────────────────

const ABSOLUTE_URL = /^([a-z][a-z0-9+.-]*:)?\/\//i;

/**
 * Split a URL-ish string into its parts by hand rather than through `URL`:
 * the output must keep the input's spelling (relative stays relative, no
 * re-encoding), and any string has to come back, parseable or not.
 */
function splitUrl(value: string): {
  authority: string;
  path: string;
  query: string;
  fragment: string;
  hasQuery: boolean;
  hasFragment: boolean;
} {
  let rest = value;
  let authority = "";
  const absolute = ABSOLUTE_URL.exec(rest);
  if (absolute) {
    const afterSlashes = absolute[0].length;
    const authorityEnd = rest.slice(afterSlashes).search(/[/?#]/);
    const end = authorityEnd === -1 ? rest.length : afterSlashes + authorityEnd;
    authority = rest.slice(0, end);
    rest = rest.slice(end);
  }
  const hashAt = rest.indexOf("#");
  const fragment = hashAt === -1 ? "" : rest.slice(hashAt + 1);
  if (hashAt !== -1) rest = rest.slice(0, hashAt);
  const queryAt = rest.indexOf("?");
  const query = queryAt === -1 ? "" : rest.slice(queryAt + 1);
  const path = queryAt === -1 ? rest : rest.slice(0, queryAt);
  return {
    authority,
    path,
    query,
    fragment,
    hasQuery: queryAt !== -1,
    hasFragment: hashAt !== -1,
  };
}

/** `https://user:pass@host` → `https://host`. */
function stripUserinfo(authority: string): string {
  const scheme = ABSOLUTE_URL.exec(authority)?.[0] ?? "";
  const host = authority.slice(scheme.length);
  const at = host.lastIndexOf("@");
  return at === -1 ? authority : `${scheme}${host.slice(at + 1)}`;
}

function looksLikeUrl(value: string): boolean {
  return (
    ABSOLUTE_URL.test(value) ||
    value.startsWith("/") ||
    value.startsWith("?") ||
    value.startsWith("#")
  );
}

function scrubUrlUnsafe(value: string): string {
  const parts = splitUrl(value);
  return `${stripUserinfo(parts.authority)}${scrubPathname(parts.path)}${
    parts.hasQuery ? `?${scrubParamString(parts.query)}` : ""
  }${parts.hasFragment ? `#${scrubFragment(parts.fragment)}` : ""}`;
}

/**
 * Remove every credential from one URL: the secret segment of a registered
 * route, the value of every secret query/fragment key, and userinfo. Works on
 * absolute URLs (any scheme, `mcpjam://` included), protocol-relative ones,
 * and relative paths; keeps everything else as written.
 *
 * Never throws. A value that is not URL-shaped is scrubbed as free text.
 */
export function scrubCredentialUrl(value: string): string {
  if (typeof value !== "string" || value === "") return value;
  try {
    if (!looksLikeUrl(value)) return scrubCredentialsInText(value);
    const scrubbed = scrubUrlUnsafe(value);
    return scrubbed === value ? value : scrubbed;
  } catch {
    return safeTextFallback(value);
  }
}

/** Last resort for a value the URL path could not handle. */
function safeTextFallback(value: string): string {
  try {
    return scrubCredentialsInText(value);
  } catch {
    return CREDENTIAL_PLACEHOLDER;
  }
}

// ── Free text ──────────────────────────────────────────────────────────

/** A slash, raw or percent-encoded (URLs nested in other URLs' queries). */
const SLASH = "(?:/|%2[Ff])";
/** A segment inside free text: stops at the usual URL and prose delimiters. */
const TEXT_SEGMENT = `((?!:)(?:(?!%2[Ff]|%3[Ff]|%23)[^/?#\\s"'<>\\\\()[\\]\`|,;])+)`;

interface TextPattern {
  regex: RegExp;
  reserved: readonly string[];
}

function textPatternFor(compiled: CompiledRoute): TextPattern {
  const segments = compiled.route.pattern.split("/").filter(Boolean);
  const source = segments
    .map((segment) =>
      segment.startsWith(":") ? TEXT_SEGMENT : escapeRegex(segment),
    )
    .join(SLASH);
  // No boundary before the leading slash: in prose the route follows a host
  // (`app.mcpjam.com/results/…`) as often as a space, and the slash itself is
  // what keeps `/foo-results/…` out.
  return {
    regex: new RegExp(`${SLASH}${source}`, "g"),
    reserved: compiled.route.reserved ?? [],
  };
}

const TEXT_PATH_PATTERNS: readonly (TextPattern & {
  compiled: CompiledRoute;
})[] = PATH_ROUTES.map((compiled) => ({
  ...textPatternFor(compiled),
  compiled,
}));

/** An absolute URL inside prose. Same shape the SDK's conformance scrubber uses. */
const EMBEDDED_URL =
  /\b[a-z][a-z0-9+.-]*:\/\/(?:\[[0-9A-Fa-f:.]+\])?[^\s"'<>()[\]`]*/gi;

/** Trailing sentence punctuation a URL in prose should not swallow. */
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/**
 * `?code=…`, `&state=…`, `#access_token=…`, and their percent-encoded
 * spellings (a callback URL quoted inside another URL's query). Also at the
 * very start of the text, where a form body (`code=…&state=…`) begins.
 */
const TEXT_PARAM =
  /((?:^|[?&#]|%3[Ff]|%26|%23)\s*)([A-Za-z0-9_.\-[\]]+)((?:=|%3[Dd]))((?:(?!%26|%23)[^&#\s"'<>\\`])*)/g;

function scrubTextPaths(text: string): string {
  let out = text;
  for (const pattern of TEXT_PATH_PATTERNS) {
    const { secretGroup, paramNames } = pattern.compiled;
    out = out.replace(pattern.regex, (match: string, ...groups: unknown[]) => {
      const secret = groups.slice(0, paramNames.length)[secretGroup - 1];
      if (
        typeof secret !== "string" ||
        pattern.reserved.includes(safeDecode(secret).toLowerCase())
      ) {
        return match;
      }
      // Every registered secret is its template's last segment, so it is the
      // tail of the match.
      return `${match.slice(0, match.length - secret.length)}${CREDENTIAL_PLACEHOLDER}`;
    });
  }
  return out;
}

function scrubTextParams(text: string, depth = 0): string {
  return text.replace(
    TEXT_PARAM,
    (match, lead: string, key: string, eq: string, value: string) => {
      if (value === "" || value.startsWith(CREDENTIAL_PLACEHOLDER)) {
        return match;
      }
      if (isSecretParamKey(safeDecode(key))) {
        // Sentence punctuation after a value in prose is not part of it.
        const trailing = TRAILING_PUNCTUATION.exec(value)?.[0] ?? "";
        return `${lead}${key}${eq}${CREDENTIAL_PLACEHOLDER}${trailing}`;
      }
      // A non-secret value can be a whole URL, percent-encoded
      // (`redirect=https%3A%2F%2F…%3Fcode%3D…`); its own parameters are
      // inside it. Bounded: each level is a strict substring.
      if (depth >= 4) return match;
      const inner = scrubTextParams(value, depth + 1);
      return inner === value ? match : `${lead}${key}${eq}${inner}`;
    },
  );
}

/**
 * Remove credentials from free text: every absolute URL in it is scrubbed as
 * a URL, every registered credential path (with or without a host, raw or
 * percent-encoded) loses its secret segment, and every `?key=` / `&key=` /
 * `#key=` with a secret key loses its value.
 *
 * Never throws; text without credentials comes back identical.
 */
export function scrubCredentialsInText(text: string): string {
  if (typeof text !== "string" || text === "") return text;
  try {
    let out = text.replace(EMBEDDED_URL, (url) => {
      const trailing = TRAILING_PUNCTUATION.exec(url)?.[0] ?? "";
      const core = trailing ? url.slice(0, -trailing.length) : url;
      return `${scrubUrlUnsafe(core)}${trailing}`;
    });
    out = scrubTextPaths(out);
    out = scrubTextParams(out);
    return out;
  } catch {
    return CREDENTIAL_PLACEHOLDER;
  }
}

/** Whether a string still carries a credential this module would scrub. */
export function containsCredential(text: string): boolean {
  return scrubCredentialsInText(text) !== text;
}

// ── Replay gating ──────────────────────────────────────────────────────

export interface LocationLike {
  pathname: string;
  search?: string;
  hash?: string;
}

/**
 * Whether a page must not be recorded at all, by any recorder, at any
 * privacy level: a registered credential path, a callback route, or any
 * secret query or fragment key on any path. A recorder snapshots the address
 * bar, the DOM that renders the secret, and the network requests that send
 * it; scrubbing those afterwards is not a guarantee, not recording is.
 */
export function isReplayBlockedLocation(location: LocationLike): boolean {
  try {
    const pathname = location.pathname ?? "";
    if (matchCredentialPath(pathname)) return true;
    if (matchCallbackPath(pathname)) return true;
    if (location.search && hasSecretKey(location.search)) return true;
    // A credential nested in a parameter's value (`?redirect=<callback url>`).
    const tail = `${location.search ?? ""}${location.hash ?? ""}`;
    if (tail && scrubCredentialsInText(tail) !== tail) return true;
    const hash = location.hash ?? "";
    if (hash.length > 1) {
      const body = hash.slice(1);
      if (body.startsWith("/")) {
        const end = body.search(/[?#]/);
        const path = end === -1 ? body : body.slice(0, end);
        if (matchCredentialPath(path) || matchCallbackPath(path)) return true;
        if (end !== -1 && hasSecretKey(body.slice(end))) return true;
      } else if (body.includes("=") && hasSecretKey(body)) {
        return true;
      }
    }
    return false;
  } catch {
    // Cannot tell: do not record.
    return true;
  }
}

/** `isReplayBlockedLocation` for a full or relative URL string. */
export function isReplayBlockedUrl(url: string): boolean {
  try {
    const { path, query, fragment } = splitUrl(url);
    return isReplayBlockedLocation({
      pathname: path || "/",
      search: query ? `?${query}` : "",
      hash: fragment ? `#${fragment}` : "",
    });
  } catch {
    return true;
  }
}

// ── The walker ─────────────────────────────────────────────────────────

/** Deeper or larger than this is not a telemetry payload; refuse it. */
const WALK_MAX_DEPTH = 64;
const WALK_MAX_NODES = 200_000;

export class TelemetryScrubError extends Error {
  constructor(reason: string) {
    super(`telemetry scrub failed: ${reason}`);
    this.name = "TelemetryScrubError";
  }
}

export interface ScrubTelemetryOptions {
  /**
   * Keys whose values are left alone at the TOP level of the value — e.g.
   * PostHog's `token` property, which is the project key and must reach
   * ingestion as is.
   */
  preserveTopLevelKeys?: readonly string[];
}

/**
 * Scrub every credential out of a JSON-ish value: every string (URL or
 * prose) and every object KEY (heatmap data is keyed by URL). The input is
 * never mutated: whatever changed is copied, and a value with nothing to
 * scrub comes back as the same object. Non-plain objects (Dates, typed
 * arrays) pass through.
 *
 * THROWS `TelemetryScrubError` on a cycle, excessive depth, or excessive size
 * — the one function here that does, because its callers must know the value
 * is not clean. Use `scrubTelemetryEvent` for the fail-closed wrapper.
 */
export function scrubTelemetryValue<T>(
  value: T,
  options: ScrubTelemetryOptions = {},
): T {
  const preserve = new Set(options.preserveTopLevelKeys ?? []);
  const seen = new Set<object>();
  let nodes = 0;
  const walk = (node: unknown, depth: number): unknown => {
    if (++nodes > WALK_MAX_NODES) throw new TelemetryScrubError("too large");
    if (typeof node === "string") return scrubCredentialsInText(node);
    if (node === null || typeof node !== "object") return node;
    if (depth > WALK_MAX_DEPTH) throw new TelemetryScrubError("too deep");
    if (seen.has(node)) throw new TelemetryScrubError("cycle");
    seen.add(node);
    try {
      // Copy on write: a value with nothing to scrub comes back as the very
      // same object, so callers that check identity — and the cost of the
      // common case — are unaffected.
      if (Array.isArray(node)) {
        let changed = false;
        const out = node.map((item) => {
          const next = walk(item, depth + 1);
          if (next !== item) changed = true;
          return next;
        });
        return changed ? out : node;
      }
      const proto = Object.getPrototypeOf(node);
      if (proto !== Object.prototype && proto !== null) return node;
      let changed = false;
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) {
        const cleanKey = scrubCredentialsInText(key);
        const next =
          depth === 0 && preserve.has(key) ? child : walk(child, depth + 1);
        if (cleanKey !== key || next !== child) changed = true;
        out[cleanKey] = next;
      }
      return changed ? out : node;
    } finally {
      seen.delete(node);
    }
  };
  return walk(value, 0) as T;
}

/**
 * Fields that hold a URL or a path on the events our sinks send. When the
 * walker cannot finish, these are deleted so what remains carries no URL.
 */
export const URL_BEARING_FIELDS: readonly string[] = [
  // PostHog
  "$current_url",
  "$referrer",
  "$referring_domain",
  "$pathname",
  "$host",
  "$session_entry_url",
  "$session_entry_pathname",
  "$session_entry_referrer",
  "$initial_current_url",
  "$initial_pathname",
  "$initial_referrer",
  "$prev_pageview_pathname",
  "$prev_pageview_url",
  "$external_click_url",
  "$elements_chain",
  "$elements",
  "$exception_list",
  "$heatmap_data",
  "$$heatmap",
  "$web_vitals_LCP_event",
  "$web_vitals_CLS_event",
  "$web_vitals_FCP_event",
  "$web_vitals_INP_event",
  "$snapshot_data",
  "failed_request",
  // Sentry
  "request",
  "breadcrumbs",
  "transaction",
  "spans",
  "exception",
  "message",
  "logentry",
  "urls",
  "url",
  "contexts",
  "extra",
];

/**
 * Fail closed: scrub `event`; if the walker cannot finish, delete every
 * URL-bearing field (at the top level and one level down, where PostHog keeps
 * `properties`) and scrub the rest; if THAT fails, return `null` so the
 * caller drops the event. Never throws.
 */
export function scrubTelemetryEvent<T extends object>(
  event: T,
  options: ScrubTelemetryOptions & {
    onFallback?: (reason: string) => void;
  } = {},
): T | null {
  try {
    return scrubTelemetryValue(event, options);
  } catch (error) {
    options.onFallback?.(error instanceof Error ? error.message : "unknown");
  }
  try {
    const stripped = stripUrlBearingFields(event);
    return scrubTelemetryValue(stripped, options);
  } catch {
    return null;
  }
}

function stripUrlBearingFields<T extends object>(event: T): T {
  const copy: Record<string, unknown> = {
    ...(event as Record<string, unknown>),
  };
  for (const field of URL_BEARING_FIELDS) delete copy[field];
  for (const [key, child] of Object.entries(copy)) {
    if (child && typeof child === "object" && !Array.isArray(child)) {
      const inner: Record<string, unknown> = {
        ...(child as Record<string, unknown>),
      };
      for (const field of URL_BEARING_FIELDS) delete inner[field];
      copy[key] = inner;
    }
  }
  return copy as T;
}
