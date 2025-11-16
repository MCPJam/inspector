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
  return "http://localhost:6274/oauth/callback";
}
