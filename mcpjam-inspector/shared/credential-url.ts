/**
 * Credential-bearing URLs: share and result links whose last path segment IS
 * the credential. Moved here unchanged from `client/src/lib/PosthogUtils.ts`
 * (which still re-exports it) so the PostHog relay redacts with the same
 * function the client does, rather than a second copy.
 */

/**
 * A score result link is a bearer credential — the token in `/results/<token>`
 * is the only thing standing between a private run and anyone who has the URL.
 * Autocapture attaches `$current_url` to every captured event, so a single
 * click on that page would ship the credential to analytics, where it lands in
 * logs and exports that no one thinks of as secret-bearing. Replace the token
 * with a placeholder before anything leaves the browser; the path itself is
 * still useful, and the token never was.
 */
// Every path whose LAST segment is a bearer credential. Autocapture attaches
// `$current_url` to each event, so a share viewer's address bar would ship the
// redeem token to PostHog on every click if these were not redacted.
export const CREDENTIAL_PATH_PREFIXES = [
  "/results/",
  "/conformance/shared/",
  "/evals/shared/",
];

export function scrubSensitiveUrl(value: string): string {
  let out = value;
  for (const prefix of CREDENTIAL_PATH_PREFIXES) {
    const escaped = prefix.replace(/[/\-\\^$*+?.()|[\]{}]/g, "\\$&");
    out = out.replace(new RegExp(`(${escaped})[^/?#]+`, "g"), "$1[redacted]");
  }
  // Organization ids are internal identifiers and organization routes are
  // captured automatically by PostHog on otherwise privacy-safe events.
  out = out.replace(/(\/organizations\/)[^/?#]+/g, "$1[redacted]");
  return out;
}
