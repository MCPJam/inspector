/**
 * The URL sanitizer the PostHog client (`client/src/lib/PosthogUtils.ts`,
 * which re-exports it) and the PostHog relay (`shared/telemetry-privacy.ts`)
 * share, so the two redact with the same function rather than two copies.
 *
 * Which URLs carry a credential is not decided here: that is the registry in
 * `credential-urls.ts`, which every telemetry exit reads. This module adds
 * only the analytics-specific organization-id redaction on top.
 */
import { CREDENTIAL_ROUTES, scrubCredentialUrl } from "./credential-urls";

/**
 * Every page path whose LAST segment is the credential, as a prefix
 * (`/results/`), derived from the registry. Autocapture attaches
 * `$current_url` to each event, so a share viewer's address bar would ship
 * the token to PostHog on every click if these were not redacted.
 */
export const CREDENTIAL_PATH_PREFIXES: readonly string[] =
  CREDENTIAL_ROUTES.flatMap((route) => {
    if (route.secretIn !== "path" || route.scope !== "page") return [];
    const secret = `:${route.secretParam}`;
    if (!route.pattern.endsWith(secret)) return [];
    const prefix = route.pattern.slice(0, -secret.length);
    return prefix.includes(":") ? [] : [prefix];
  });

/**
 * Credentials out of a URL (share tokens, OAuth codes, secret query and
 * fragment keys; see `scrubCredentialUrl`), plus organization ids.
 * Organization ids are internal identifiers, and organization routes are
 * captured automatically by PostHog on otherwise privacy-safe events.
 */
export function scrubSensitiveUrl(value: string): string {
  return scrubCredentialUrl(value).replace(
    /(\/organizations\/)[^/?#]+/g,
    "$1[redacted]",
  );
}
