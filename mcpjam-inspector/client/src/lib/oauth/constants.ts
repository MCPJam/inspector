/**
 * OAuth Constants for MCPJam Inspector
 */

/**
 * Static Client ID Metadata Document URL for MCPJam Inspector
 * This URL hosts the client metadata per draft-parecki-oauth-client-id-metadata-document-03
 * Used when authorization servers support Client ID Metadata Documents
 */
export const MCPJAM_CLIENT_ID =
  "https://www.mcpjam.com/.well-known/oauth/client-metadata.json";

export function getRedirectUri(): string {
  if (typeof window !== "undefined") {
    return `${window.location.origin}/oauth/callback/debug`;
  }

  // Default fallback
  return "http://localhost:6274/oauth/callback/debug";
}
