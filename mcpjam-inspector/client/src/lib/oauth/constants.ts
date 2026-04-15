/**
 * OAuth Constants for MCPJam Inspector
 */

export const MCPJAM_HOSTED_APP_ORIGIN = "https://app.mcpjam.com";
const LOCALHOST_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);
const HOSTED_REDIRECT_HOSTNAMES = new Set([
  "app.mcpjam.com",
  "staging.mcpjam.com",
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
  // Check if running in Electron with custom protocol support
  if (typeof window !== "undefined" && (window as any).electron) {
    return "mcpjam://oauth/callback";
  }

  if (typeof window !== "undefined") {
    return `${resolveBrowserOAuthRedirectOrigin(
      window.location
    )}/oauth/callback`;
  }

  // Default fallback
  return "http://localhost:6274/oauth/callback";
}
