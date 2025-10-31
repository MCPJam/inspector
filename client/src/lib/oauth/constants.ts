/**
 * OAuth Constants for MCPJam Inspector
 * Supports both 2025-06-18 and 2025-11-25 (draft) protocol versions
 */

/**
 * Static Client ID Metadata Document URL for MCPJam Inspector
 * This URL hosts the client metadata per draft-parecki-oauth-client-id-metadata-document-03
 * Used when authorization servers support Client ID Metadata Documents
 */
export const MCPJAM_CLIENT_ID =
  "https://www.mcpjam.com/.well-known/oauth/client-metadata.json";

/**
 * Redirect URIs that match what's in the CIMD document
 * These cover all deployment scenarios:
 * - Custom protocol for Electron app
 * - Production web
 * - Local development ports
 */
export const REDIRECT_URIS = [
  "mcpjam://oauth/callback",
  "mcpjam://authkit/callback",
  "https://www.mcpjam.com/oauth/callback",
  "https://www.mcpjam.com/authkit/callback",
  "http://127.0.0.1:6274/oauth/callback",
  "http://127.0.0.1:6274/oauth/callback/debug",
  "http://127.0.0.1:6274/callback",
] as const;

/**
 * Get the appropriate redirect URI based on current environment
 */
export function getRedirectUri(): string {
  // Check if running in Electron with custom protocol support
  if (typeof window !== "undefined" && (window as any).electron) {
    return "mcpjam://oauth/callback";
  }

  // In browser, detect current port
  if (typeof window !== "undefined") {
    const port = window.location.port;

    // Production (no port or port 443)
    if (!port || port === "443") {
      return "https://www.mcpjam.com/oauth/callback";
    }

    // Local development - use detected port
    return `http://localhost:${port}/oauth/callback`;
  }

  // Default fallback
  return "http://localhost:3000/oauth/callback";
}

/**
 * Validates that a redirect URI is in the approved list
 */
export function isValidRedirectUri(uri: string): boolean {
  return REDIRECT_URIS.includes(uri as any);
}
