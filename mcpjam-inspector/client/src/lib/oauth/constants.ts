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
 * `score.mcpjam.com` and numbered Inspector PR previews run authorizations, so
 * they keep their own callbacks.
 *
 * Adding a host here mints a new `redirect_uri`. Dynamic registration sends it
 * per-flow and needs nothing else, but Client ID Metadata Document flows only
 * accept URIs listed in the document at `MCPJAM_CLIENT_ID` — a new host must be
 * added there too, or CIMD servers will reject the authorization. Preview hosts
 * are ephemeral and cannot be listed, so `supportsMcpJamCimdRedirect` steers
 * them to DCR instead.
 */
const HOSTED_REDIRECT_HOSTNAMES = new Set([
  "app.mcpjam.com",
  "staging.mcpjam.com",
  "score.mcpjam.com",
  "www.score.mcpjam.com",
]);
const INSPECTOR_PREVIEW_HOSTNAME_PATTERNS = [
  /^pr-(?:be-)?\d+\.mcpjam\.dev$/i,
  /^mcp-inspector-pr-(?:be-)?\d+\.up\.railway\.app$/i,
];

export function protectedPreviewOrigin(hostname: string): string | undefined {
  const match = hostname.match(
    /^mcp-inspector-(pr-(?:be-)?\d+)\.up\.railway\.app$/i,
  );
  return match ? `https://${match[1].toLowerCase()}.mcpjam.dev` : undefined;
}

/**
 * Move raw Railway previews to the protected preview-router origin before
 * OAuth stores any pending state. The path, query, and hash are preserved.
 */
export function resolveProtectedPreviewAppUrl(
  locationLike: Pick<Location, "hostname" | "href">,
): string | undefined {
  const protectedOrigin = protectedPreviewOrigin(locationLike.hostname);
  if (!protectedOrigin) return undefined;

  const target = new URL(locationLike.href);
  const protectedUrl = new URL(protectedOrigin);
  target.protocol = protectedUrl.protocol;
  target.host = protectedUrl.host;
  return target.toString();
}

function isInspectorPreviewHostname(hostname: string): boolean {
  return INSPECTOR_PREVIEW_HOSTNAME_PATTERNS.some((pattern) =>
    pattern.test(hostname),
  );
}

/** Ephemeral preview callbacks cannot be listed in the public CIMD document. */
export function supportsMcpJamCimdRedirect(
  locationLike: Pick<Location, "hostname">,
): boolean {
  return !isInspectorPreviewHostname(locationLike.hostname);
}

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
  locationLike: Pick<Location, "protocol" | "origin" | "hostname">,
): string {
  if (locationLike.protocol !== "http:" && locationLike.protocol !== "https:") {
    // Defensive fallback for non-browser-like locations. Electron exits earlier.
    return MCPJAM_HOSTED_APP_ORIGIN;
  }

  if (LOCALHOST_HOSTNAMES.has(locationLike.hostname)) {
    return locationLike.origin;
  }

  // Railway preview names are reclaimable after teardown. Never mint an OAuth
  // callback for that raw origin; use the protected preview-router hostname,
  // whose ownership remains with MCPJam, instead.
  const previewOrigin = protectedPreviewOrigin(locationLike.hostname);
  if (previewOrigin) {
    return previewOrigin;
  }

  if (
    HOSTED_REDIRECT_HOSTNAMES.has(locationLike.hostname) ||
    locationLike.hostname.endsWith(".app.mcpjam.com") ||
    isInspectorPreviewHostname(locationLike.hostname)
  ) {
    return locationLike.origin;
  }

  return MCPJAM_HOSTED_APP_ORIGIN;
}

export function getRedirectUri(): string {
  if (typeof window !== "undefined") {
    return `${resolveBrowserOAuthRedirectOrigin(
      window.location,
    )}/oauth/callback`;
  }

  // Default fallback
  return "http://localhost:6274/oauth/callback";
}
