/**
 * OAuth Constants for MCPJam Inspector
 */

export const MCPJAM_HOSTED_APP_ORIGIN = "https://app.mcpjam.com";
const LOCALHOST_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);
/**
 * Hosts that receive their OWN OAuth callback rather than the app's.
 *
 * A host not listed here sends the browser back to `app.mcpjam.com`, which is
 * correct for a vanity domain that only renders a page — but fatal for one that
 * has to finish an authorization. The pending marker, the resume record and the
 * guest cookie are all per-origin, so a callback that lands on a different host
 * cannot see any of them: the flow dead-ends and the visitor loses their work.
 * `score.mcpjam.com` runs authorizations, so it keeps its own callback.
 *
 * Adding a host here mints a new `redirect_uri`. Dynamic registration sends it
 * per-flow and needs nothing else, but Client ID Metadata Document flows only
 * accept URIs listed in the document at `MCPJAM_CLIENT_ID` — a new host must be
 * added there too, or CIMD servers will reject the authorization.
 */
const HOSTED_REDIRECT_HOSTNAMES = new Set([
  "app.mcpjam.com",
  "staging.mcpjam.com",
  "score.mcpjam.com",
  "www.score.mcpjam.com",
]);

/**
 * Static Client ID Metadata Document URL for MCPJam Inspector
 * This URL hosts the client metadata per draft-parecki-oauth-client-id-metadata-document-03
 * Used when authorization servers support Client ID Metadata Documents
 *
 * Note: the metadata document is hosted on `www`, but its registered browser
 * redirect URIs point at the hosted app on `app.mcpjam.com`.
 */
export const MCPJAM_CLIENT_ID =
  "https://www.mcpjam.com/.well-known/oauth/client-metadata.json";

export function resolveBrowserOAuthRedirectOrigin(
  locationLike: Pick<Location, "protocol" | "origin" | "hostname">
): string {
  if (locationLike.protocol !== "http:" && locationLike.protocol !== "https:") {
    // Defensive fallback for non-browser-like locations. Electron exits earlier.
    return MCPJAM_HOSTED_APP_ORIGIN;
  }

  if (LOCALHOST_HOSTNAMES.has(locationLike.hostname)) {
    return locationLike.origin;
  }

  if (
    HOSTED_REDIRECT_HOSTNAMES.has(locationLike.hostname) ||
    locationLike.hostname.endsWith(".app.mcpjam.com")
  ) {
    return locationLike.origin;
  }

  return MCPJAM_HOSTED_APP_ORIGIN;
}

export function getRedirectUri(): string {
  if (typeof window !== "undefined") {
    return `${resolveBrowserOAuthRedirectOrigin(
      window.location
    )}/oauth/callback`;
  }

  // Default fallback
  return "http://localhost:6274/oauth/callback";
}
