/**
 * Utility functions for generating dynamic URLs based on environment configuration
 */

/**
 * Gets the base URL for the application
 * Uses environment variables to determine the correct URL for both client and server contexts
 */
export function getBaseUrl(): string {
  // Client-side: use window.location.origin if available
  if (typeof window !== "undefined") {
    return window.location.origin;
  }

  // Server-side: check environment variables
  const baseUrl = process.env.BASE_URL || process.env.NEXT_PUBLIC_BASE_URL;
  if (baseUrl) {
    return baseUrl;
  }

  // Fallback: construct from PORT environment variable
  const port = process.env.PORT || "3000";
  return `http://localhost:${port}`;
}

/**
 * Gets the OAuth callback URL for the application
 */
export function getOAuthCallbackUrl(): string {
  return `${getBaseUrl()}/oauth/callback`;
}

/**
 * Gets the current port number
 */
export function getPort(): string {
  return process.env.PORT || "3000";
}
