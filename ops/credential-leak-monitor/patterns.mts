/**
 * Leak-monitor patterns, GENERATED from the credential-URL registry.
 *
 * `mcpjam-inspector/shared/credential-urls.ts` is the one place that knows
 * which URLs carry a secret. Every telemetry exit scrubs with it, so a URL in
 * PostHog or Sentry should only ever show a registered secret as
 * `[redacted]`. This module turns the same registry into regular expressions
 * that match the UNREDACTED shape of each route, so the daily monitor counts
 * what slipped past a scrubber. Nothing here is a hand-kept list of routes:
 * add a route to the registry and the monitor watches it on the next run.
 *
 * The expressions are written in the subset of syntax that JavaScript and
 * RE2 (ClickHouse, which runs HogQL `match`/`extract`) both accept: no
 * lookaround, no backreferences, no named groups. Each pattern has exactly
 * ONE capturing group, the secret, so HogQL `extract()` and `RegExp#exec`
 * return the same thing and reserved values (`/user-testing/<id>/edit`) can
 * be excluded after the match.
 *
 * Pure: no I/O. `run.mts` does the network calls; the unit test lives in
 * `mcpjam-inspector/shared/__tests__/credential-leak-monitor.test.ts`.
 */
import {
  CREDENTIAL_ROUTES,
  SECRET_PARAM_KEYS,
  type CredentialRoute,
} from "../../mcpjam-inspector/shared/credential-urls.ts";

export interface LeakPattern {
  /** Registry route id, or `secret-param` / `userinfo` for the catch-alls. */
  id: string;
  /** Pattern source, valid in both JavaScript and RE2. */
  source: string;
  /** Match case-insensitively (`i` flag in JS, `(?i)` in RE2). */
  caseInsensitive: boolean;
  /** Lowercased secret values that are app vocabulary, not secrets. */
  reserved: readonly string[];
}

/** Ids of the two patterns that are not registry routes. */
export const GENERIC_SECRET_PARAM_ID = "secret-param";
export const USERINFO_ID = "userinfo";

// ── Building blocks ────────────────────────────────────────────────────

/** Characters that end a URL inside a property value, an attribute or prose. */
const STOP = `/?#\\s"'<>`;
/**
 * A path segment that is not a secret (a slug, an id). Anything up to the
 * next delimiter.
 */
const ANY_SEGMENT = `[^${STOP}]+`;
/**
 * A path SECRET that is still in the clear. Its first character rules out
 * every form a scrubbed or templated URL takes: `[redacted]` / `[name]`,
 * their percent-encoded spelling (`%5B…`), and route templates (`:token`,
 * `<token>`, `{token}`, `*`).
 */
const CLEAR_SECRET_SEGMENT = `([^${STOP}\\[%:{*][^${STOP}]*)`;
/** A query or fragment VALUE still in the clear (same exclusions). */
const VALUE_STOP = `&#\\s"'<>`;
const CLEAR_SECRET_VALUE = `([^${VALUE_STOP}\\[%:{*][^${VALUE_STOP}]*)`;
/**
 * Where a URL may start: the start of the value, or a delimiter in an
 * attribute / prose (`$elements_chain` holds `href="/results/…"`), then an
 * optional scheme and authority.
 */
const URL_START = `(?:^|[\\s"'=\\(<,])(?:[a-zA-Z][a-zA-Z0-9+.-]*:)?(?://[^${STOP}]*)?`;
/** The legacy hash router puts the path after `#`: `/#/results/<token>`. */
const HASH_ROUTER = `(?:[^?#\\s"'<>]*#)?`;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

/**
 * Query/fragment keys whose value is a credential on any URL, as a regex
 * alternation. `SECRET_PARAM_KEYS` is enumerated from the registry; the
 * FAMILIES below mirror the registry's `SECRET_PARAM_KEY_PATTERN`, which is
 * not exported. The unit test pins this alternation to `isSecretParamKey`
 * so the two cannot drift silently.
 */
const SECRET_KEY_FAMILIES = [
  "x-amz-[a-z0-9_-]*",
  "x-goog-[a-z0-9_-]*",
  "[a-z0-9_.-]*(?:token|secret|password|signature|apikey|api_key|credential)",
];

export function secretKeyAlternation(): string {
  const keys = [...SECRET_PARAM_KEYS]
    // Longest first: `access_token` before `token`, `_token` before `t`.
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .map(escapeRegex);
  return `(?:${[...keys, ...SECRET_KEY_FAMILIES].join("|")})`;
}

/** A route template's path as a regex (non-capturing except the secret). */
function pathSource(route: CredentialRoute): string {
  const splat = route.pattern.endsWith("*");
  const body = splat ? route.pattern.slice(0, -1) : route.pattern;
  const segments = body.split("/").map((segment) => {
    if (!segment.startsWith(":")) return escapeRegex(segment);
    if (route.secretIn === "path" && segment.slice(1) === route.secretParam) {
      return CLEAR_SECRET_SEGMENT;
    }
    return ANY_SEGMENT;
  });
  return `${segments.join("/")}${splat ? `[^?#\\s"'<>]*` : ""}`;
}

/** Callback pages: a query-secret page route with a concrete path. */
function isCallbackRoute(route: CredentialRoute): boolean {
  return (
    route.secretIn === "query" &&
    route.scope === "page" &&
    route.pattern !== "/*"
  );
}

function patternFor(route: CredentialRoute): LeakPattern {
  if (route.secretIn === "path") {
    const params = route.pattern
      .split("/")
      .filter((segment) => segment.startsWith(":"));
    if (params.at(-1) !== `:${route.secretParam}`) {
      // The scrubber relies on the same invariant; so does `extract()` here.
      throw new Error(
        `credential route ${route.id}: the secret must be the last path parameter`,
      );
    }
    return {
      id: route.id,
      source: `${URL_START}${HASH_ROUTER}${pathSource(route)}`,
      caseInsensitive: false,
      reserved: (route.reserved ?? []).map((value) => value.toLowerCase()),
    };
  }
  // A callback leaks through any secret key (`code` and `state` both); other
  // query/fragment routes through their own key. Everything else is caught by
  // the generic `secret-param` pattern.
  const key = isCallbackRoute(route)
    ? secretKeyAlternation()
    : escapeRegex(route.secretParam);
  const delimiter = route.secretIn === "query" ? "\\?" : "#";
  return {
    id: route.id,
    source: `${URL_START}${pathSource(route)}${delimiter}(?:[^#\\s"'<>]*&)?${key}=${CLEAR_SECRET_VALUE}`,
    caseInsensitive: true,
    reserved: [],
  };
}

/**
 * Every pattern, in the order a URL is classified: path routes first (the
 * most specific), then query and fragment routes, then the catch-alls. A URL
 * is attributed to the FIRST pattern it matches.
 */
export function buildLeakPatterns(): LeakPattern[] {
  const routes = CREDENTIAL_ROUTES as readonly CredentialRoute[];
  const byLocation = (location: CredentialRoute["secretIn"]) =>
    routes.filter((route) => route.secretIn === location);
  // Within query/fragment: concrete paths before `/*`, so `/api/*?_token=`
  // is attributed to its route and not to `?t=` on any path.
  const specificFirst = (list: CredentialRoute[]) =>
    [...list].sort(
      (a, b) => Number(a.pattern === "/*") - Number(b.pattern === "/*"),
    );
  const ordered = [
    ...byLocation("path"),
    ...specificFirst([...byLocation("query"), ...byLocation("fragment")]),
  ];
  const known = new Set(["path", "query", "fragment"]);
  for (const route of routes) {
    if (!known.has(route.secretIn)) {
      throw new Error(
        `credential route ${route.id}: unknown secretIn ${String(route.secretIn)}; teach ops/credential-leak-monitor/patterns.mts about it`,
      );
    }
  }
  return [
    ...ordered.map(patternFor),
    {
      id: GENERIC_SECRET_PARAM_ID,
      source: `[?&#]${secretKeyAlternation()}=${CLEAR_SECRET_VALUE}`,
      caseInsensitive: true,
      reserved: [],
    },
    {
      id: USERINFO_ID,
      // `https://user:pass@host`: the scrubber removes userinfo entirely.
      source: `[a-zA-Z][a-zA-Z0-9+.-]*://([^${STOP}@]+)@`,
      caseInsensitive: false,
      reserved: [],
    },
  ];
}

// ── JavaScript side ────────────────────────────────────────────────────

export function toRegExp(pattern: LeakPattern): RegExp {
  return new RegExp(pattern.source, pattern.caseInsensitive ? "i" : "");
}

/**
 * The id of the first pattern that finds an unredacted credential in
 * `value`, or `null`. Same semantics as the HogQL `multiIf` below.
 */
export function classifyLeak(
  value: string,
  patterns: readonly LeakPattern[] = buildLeakPatterns(),
): string | null {
  if (typeof value !== "string" || value === "") return null;
  for (const pattern of patterns) {
    const match = toRegExp(pattern).exec(value);
    if (!match) continue;
    const secret = (match[1] ?? "").toLowerCase();
    if (pattern.reserved.includes(secret)) continue;
    return pattern.id;
  }
  return null;
}

// ── PostHog (HogQL) ────────────────────────────────────────────────────

/**
 * Event properties that hold a URL or a path. `elements_chain` is a column,
 * not a property: autocapture's element chain, which carries `href`s.
 */
export const POSTHOG_URL_PROPERTIES = [
  "$current_url",
  "$referrer",
  "$pathname",
  "$external_click_url",
  "$session_entry_url",
  "$session_entry_pathname",
  "$session_entry_referrer",
  "$initial_current_url",
  "$initial_pathname",
  "$initial_referrer",
  "$prev_pageview_url",
  "$prev_pageview_pathname",
] as const;

/** A HogQL single-quoted string literal. */
export function hogqlString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function re2Source(pattern: LeakPattern): string {
  return `${pattern.caseInsensitive ? "(?i)" : ""}${pattern.source}`;
}

/**
 * The daily HogQL query: for every event in the window, check each URL
 * property against every pattern and count events by (route id, property).
 * The `platform` and `version` super properties tell an old installed build
 * from a current one. Returns no URL and no property value, only ids and
 * counts, so the result
 * can be posted to an alert channel without re-leaking what it found.
 */
export function buildHogqlQuery(
  options: { hours?: number; patterns?: readonly LeakPattern[] } = {},
): string {
  const hours = options.hours ?? 24;
  if (!Number.isInteger(hours) || hours <= 0 || hours > 24 * 31) {
    throw new Error(`hours must be an integer between 1 and 744, got ${hours}`);
  }
  const patterns = options.patterns ?? buildLeakPatterns();
  const values = [
    ...POSTHOG_URL_PROPERTIES.map(
      (name) => `coalesce(toString(properties.${name}), '')`,
    ),
    "coalesce(toString(elements_chain), '')",
  ].join(",\n        ");
  const names = [...POSTHOG_URL_PROPERTIES, "$elements_chain"]
    .map(hogqlString)
    .join(", ");
  // No SQL comments: the query is sent as is, and printed by `--dry-run`
  // under a header that says where it came from.
  return `SELECT
  splitByChar('|', hit)[1] AS route_id,
  splitByChar('|', hit)[2] AS property,
  platform,
  version,
  count() AS events
FROM (
  SELECT
    coalesce(toString(properties.platform), '') AS platform,
    coalesce(toString(properties.version), '') AS version,
    arrayJoin(arrayDistinct(arrayFilter(h -> h != '', arrayMap((u, p) -> ${hogqlClassifier(patterns)},
    [
        ${values}
    ],
    [${names}]
  )))) AS hit
  FROM events
  WHERE timestamp >= now() - INTERVAL ${hours} HOUR
)
GROUP BY route_id, property, platform, version
ORDER BY events DESC
LIMIT 1000`;
}

/**
 * The HogQL expression that classifies one value `u` found in property `p`:
 * `'<route id>|<p>'` for the first pattern that matches, `''` for none. The
 * same semantics as `classifyLeak`.
 */
export function hogqlClassifier(
  patterns: readonly LeakPattern[] = buildLeakPatterns(),
): string {
  const branches = patterns
    .map((pattern) => {
      const re = hogqlString(re2Source(pattern));
      const reserved = pattern.reserved.length
        ? ` AND NOT has([${pattern.reserved.map(hogqlString).join(", ")}], lower(extract(u, ${re})))`
        : "";
      return `      match(u, ${re})${reserved}, concat(${hogqlString(`${pattern.id}|`)}, p)`;
    })
    .join(",\n");
  return `multiIf(\n${branches},\n      ''\n    )`;
}

/**
 * A query over LITERAL sample strings only (no table): runs the classifier
 * on each sample in ClickHouse so RE2's reading of the patterns can be
 * compared with JavaScript's. `run.mts --self-test` sends it; it reads no
 * event data.
 */
export function buildHogqlSelfTest(samples: readonly string[]): string {
  return `SELECT arrayMap((u, p) -> ${hogqlClassifier()},
  [${samples.map(hogqlString).join(", ")}],
  [${samples.map((_, index) => hogqlString(String(index))).join(", ")}]
) AS hits`;
}
// ── Sentry (Discover) ──────────────────────────────────────────────────

/**
 * Discover fields the monitor reads. `url` is the request URL Sentry records
 * on an event (the page URL for browser errors, the request for server
 * errors); `transaction` is the route name, which must be a template.
 */
export const SENTRY_URL_FIELDS = ["url", "transaction"] as const;

/** A Sentry search value, quoted. `*` stays a wildcard. */
function sentryValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Coarse wildcard terms for the registered PATH routes. */
function pathWildcards(): string[] {
  const terms = new Set<string>();
  for (const route of CREDENTIAL_ROUTES as readonly CredentialRoute[]) {
    if (route.secretIn !== "path") continue;
    const firstParam = route.pattern.indexOf(":");
    terms.add(`*${route.pattern.slice(0, firstParam)}*`);
  }
  return [...terms];
}

/**
 * Coarse wildcard terms for every registry shape. Sentry search has
 * wildcards, not regular expressions, so these only NARROW what the API
 * returns; `run.mts` then classifies each event with `classifyLeak`, which
 * is what decides whether a credential is still in the clear.
 */
export function sentryUrlWildcards(): string[] {
  const terms = new Set<string>(pathWildcards());
  for (const route of CREDENTIAL_ROUTES as readonly CredentialRoute[]) {
    if (isCallbackRoute(route)) {
      terms.add(`*${route.pattern.replace(/\*$/, "")}*?*`);
    }
  }
  for (const key of SECRET_PARAM_KEYS) {
    // One- and two-letter keys (`t`, `k`) need their delimiter or the term
    // matches half the URLs in the project.
    if (key.length <= 2) {
      terms.add(`*?${key}=*`);
      terms.add(`*&${key}=*`);
      terms.add(`*#${key}=*`);
    } else {
      terms.add(`*${key}=*`);
    }
  }
  for (const family of [
    "x-amz-",
    "x-goog-",
    "token",
    "secret",
    "password",
    "signature",
    "apikey",
    "api_key",
    "credential",
  ]) {
    terms.add(`*${family}*`);
  }
  terms.add("*://*@*");
  return [...terms];
}

export interface SentryQuery {
  /** Label for the report. */
  name: string;
  /** Discover search string. */
  query: string;
}

/** Terms per request: long OR chains are split so no request is huge. */
const SENTRY_TERMS_PER_QUERY = 20;

/**
 * The Discover searches the monitor runs. Results are de-duplicated by event
 * id across searches before they are counted.
 *
 *  - `url`: any coarse term (path routes, callbacks, secret keys, userinfo).
 *  - `transaction`: path routes only (a transaction name has no query
 *    string), skipping names that are already templates (`/results/:runToken`
 *    holds a `:`), which is what every correctly named transaction looks
 *    like.
 */
export function buildSentryQueries(): SentryQuery[] {
  const queries: SentryQuery[] = [];
  const urlTerms = sentryUrlWildcards();
  for (let i = 0; i < urlTerms.length; i += SENTRY_TERMS_PER_QUERY) {
    const chunk = urlTerms.slice(i, i + SENTRY_TERMS_PER_QUERY);
    queries.push({
      name: `url ${i / SENTRY_TERMS_PER_QUERY + 1}`,
      query: chunk.map((term) => `url:${sentryValue(term)}`).join(" OR "),
    });
  }
  const transactionTerms = pathWildcards()
    .map((term) => `transaction:${sentryValue(term)}`)
    .join(" OR ");
  queries.push({
    name: "transaction",
    query: `(${transactionTerms}) !transaction:${sentryValue("*:*")}`,
  });
  return queries;
}
