/**
 * Vendor-side CONTAINMENT for credential URLs, generated from the registry.
 *
 * The code fix (`mcpjam-inspector/shared/credential-urls.ts` and every sink
 * that applies it) prevents current builds from sending a credential. It
 * cannot reach a desktop app that is already installed and has not updated.
 * These settings live in the vendors' projects instead, so they reach every
 * client, old ones included:
 *
 *  - PostHog `session_recording_url_blocklist_config`: posthog-js reads it
 *    from remote config and does not record while the page URL matches. This
 *    stops replay BEFORE capture, on old builds too.
 *  - Sentry Advanced Data Scrubbing: replaces the secret in any string of an
 *    event as it is ingested. AFTER transmission: containment, not
 *    prevention.
 *  - A PostHog ingestion transformation that drops an event whose URL
 *    properties still carry a credential. AFTER transmission too.
 *
 * Applying any of them is a change to production vendor settings and needs
 * a human go-ahead; `build.mts` only prints them. The patterns come from the
 * same builders as the leak monitor (`ops/credential-leak-monitor/`), so the
 * containment, the monitor and the scrubbers cannot disagree about what a
 * credential URL looks like.
 *
 * Pure: no I/O.
 */
import {
  CREDENTIAL_ROUTES,
  SECRET_PARAM_KEYS,
  escapeRegex,
  type CredentialRoute,
} from "../../mcpjam-inspector/shared/credential-urls.ts";
import {
  buildLeakPatterns,
  POSTHOG_URL_PROPERTIES,
  type LeakPattern,
} from "../credential-leak-monitor/patterns.mts";

// ── PostHog replay URL blocklist ───────────────────────────────────────

export interface PostHogUrlBlocklistEntry {
  url: string;
  matching: "regex";
}

/**
 * A case-insensitive spelling of a literal for an engine without flags:
 * posthog-js compiles each blocklist entry with `new RegExp(url)` and no
 * flags, so `code` must also match `Code`.
 */
function anyCase(literal: string): string {
  return [...literal]
    .map((char) => {
      const lower = char.toLowerCase();
      const upper = char.toUpperCase();
      return lower === upper ? escapeRegex(char) : `[${lower}${upper}]`;
    })
    .join("");
}

/** The page URL's path, after the scheme and host. */
const ORIGIN = "^[a-zA-Z][a-zA-Z0-9+.-]*://[^/?#]+";

function blocklistForRoute(route: CredentialRoute): string | null {
  if (route.scope !== "page") return null;
  if (route.secretIn !== "path") {
    // Query/fragment routes on a concrete path: the callbacks. The whole
    // page is blocked; `/*` routes are covered by the key entry below.
    if (route.pattern === "/*") return null;
    const path = route.pattern.endsWith("*")
      ? escapeRegex(route.pattern.slice(0, -1))
      : `${escapeRegex(route.pattern)}(?:[/?#]|$)`;
    return `${ORIGIN}${path}`;
  }
  const segments = route.pattern.split("/").filter(Boolean);
  const reserved = route.reserved?.length
    ? `(?!(?:${route.reserved.map(anyCase).join("|")})(?:[/?#]|$))`
    : "";
  const path = segments
    .map((segment) => {
      if (!segment.startsWith(":")) return escapeRegex(segment);
      return segment.slice(1) === route.secretParam
        ? `${reserved}[^/?#]+`
        : "[^/?#]+";
    })
    .join("/");
  return `${ORIGIN}/${path}`;
}

/**
 * Every page that must never be recorded: one entry per registered page
 * route, plus one for any secret query or fragment key on any page — the
 * same rule as `isReplayBlockedLocation`.
 */
export function buildPostHogUrlBlocklist(): PostHogUrlBlocklistEntry[] {
  const routes = CREDENTIAL_ROUTES as readonly CredentialRoute[];
  const entries = routes
    .map(blocklistForRoute)
    .filter((url): url is string => url !== null);
  const keys = [...SECRET_PARAM_KEYS].map(anyCase).join("|");
  entries.push(`[?&#](?:${keys})=`);
  // Presigned storage and vendor-prefixed token keys (the registry's key
  // families), case-insensitively.
  entries.push(
    `[?&#](?:${anyCase("x-amz-")}|${anyCase("x-goog-")})[^=&#]*=`,
    `[?&#][^=&#]*(?:${["token", "secret", "password", "signature", "apikey", "api_key", "credential"].map(anyCase).join("|")})=`,
  );
  return entries.map((url) => ({ url, matching: "regex" as const }));
}

// ── Sentry Advanced Data Scrubbing ─────────────────────────────────────

export interface SentryPiiConfig {
  rules: Record<
    string,
    {
      type: "pattern";
      pattern: string;
      replaceGroups: number[];
      redaction: { method: "replace"; text: string };
    }
  >;
  applications: Record<string, string[]>;
}

/**
 * Sentry's Relay PII config: one pattern rule per leak pattern, replacing
 * only the captured secret (group 1) with `[redacted]`, applied to every
 * string in the event. The leak patterns are written in the regex subset
 * Rust's `regex` crate (Relay) shares with RE2 and JavaScript: no
 * lookaround, one capturing group.
 */
export function buildSentryPiiConfig(
  patterns: readonly LeakPattern[] = buildLeakPatterns(),
): SentryPiiConfig {
  const rules: SentryPiiConfig["rules"] = {};
  for (const pattern of patterns) {
    rules[`mcpjam-credential-${pattern.id}`] = {
      type: "pattern",
      pattern: `${pattern.caseInsensitive ? "(?i)" : ""}${pattern.source}`,
      replaceGroups: [1],
      redaction: { method: "replace", text: "[redacted]" },
    };
  }
  return { rules, applications: { $string: Object.keys(rules) } };
}

// ── PostHog ingestion transformation ───────────────────────────────────

/** A Hog string literal. */
function hogString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * Source for a PostHog ingestion transformation (Hog) that DROPS an event
 * whose URL properties still match a leak pattern. Dropping, not rewriting:
 * Hog's string functions do not include a regex replace, and an event with a
 * credential is better lost than stored. Reserved segments
 * (`/user-testing/<id>/edit`) can match here and drop a harmless event;
 * acceptable for containment of old builds.
 *
 * Verify it in PostHog's transformation tester before enabling.
 */
export function buildPostHogTransformation(
  patterns: readonly LeakPattern[] = buildLeakPatterns(),
): string {
  const regexes = patterns.map(
    (pattern) =>
      `  ${hogString(`${pattern.caseInsensitive ? "(?i)" : ""}${pattern.source}`)}`,
  );
  const properties = POSTHOG_URL_PROPERTIES.map(
    (property) => `  ${hogString(property)}`,
  );
  return `// Generated by ops/telemetry-containment/build.mts from the credential-URL
// registry. Drops an event that still carries a credential URL. Containment
// for app builds that predate client-side scrubbing.
let patterns := [
${regexes.join(",\n")}
]
let urlProperties := [
${properties.join(",\n")}
]
for (let property in urlProperties) {
  let value := event.properties[property]
  if (typeof(value) == 'string') {
    for (let pattern in patterns) {
      if (match(value, pattern)) {
        return null
      }
    }
  }
}
return event
`;
}
