/**
 * Session Token Module
 *
 * Handles authentication token management for the client.
 * The token is either:
 * 1. Injected into HTML by the server (production mode)
 * 2. Fetched from /api/session-token endpoint (development mode)
 *
 * This module provides utilities to:
 * - Initialize the token before any API calls
 * - Get auth headers for fetch requests
 * - Add token to URLs for SSE/EventSource (which can't use headers)
 */

// Extend window type for the injected token
declare global {
  interface Window {
    __MCP_SESSION_TOKEN__?: string;
  }
}

let cachedToken: string | null = null;
let initPromise: Promise<string> | null = null;

/**
 * Initialize the session token.
 * Must be called before any API requests.
 *
 * In production, reads from injected window variable.
 * In development, fetches from /api/session-token endpoint.
 *
 * @returns The session token
 * @throws If token cannot be obtained
 */
export async function initializeSessionToken(): Promise<string> {
  // Already initialized
  if (cachedToken) {
    return cachedToken;
  }

  // Check for injected token (production)
  if (window.__MCP_SESSION_TOKEN__) {
    cachedToken = window.__MCP_SESSION_TOKEN__;
    return cachedToken;
  }

  // Fetch from API (development)
  if (!initPromise) {
    initPromise = fetch("/api/session-token")
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to get session token: ${response.status}`);
        }
        const data = await response.json();
        cachedToken = data.token;
        return cachedToken!;
      })
      .catch((error) => {
        initPromise = null; // Allow retry
        throw error;
      });
  }

  return initPromise;
}

/**
 * Get the session token synchronously.
 * Returns empty string if not yet initialized (will cause 401).
 *
 * @returns The session token, or empty string if not available
 */
export function getSessionToken(): string {
  if (cachedToken) {
    return cachedToken;
  }
  if (window.__MCP_SESSION_TOKEN__) {
    cachedToken = window.__MCP_SESSION_TOKEN__;
    return cachedToken;
  }
  return "";
}

/**
 * Check if session token is available.
 *
 * @returns true if token is available
 */
export function hasSessionToken(): boolean {
  return !!(cachedToken || window.__MCP_SESSION_TOKEN__);
}

/**
 * Get authentication headers for fetch requests.
 *
 * @returns Headers object with X-MCP-Session-Auth header
 */
export function getAuthHeaders(): HeadersInit {
  const token = getSessionToken();
  if (!token) {
    console.warn("[Auth] Session token not available");
    return {};
  }
  return { "X-MCP-Session-Auth": `Bearer ${token}` };
}

/**
 * Add token to URL as query parameter.
 * Required for SSE/EventSource which doesn't support custom headers.
 *
 * @param url - The URL to add token to (can be relative or absolute)
 * @returns URL with token as query parameter
 */
export function addTokenToUrl(url: string): string {
  const token = getSessionToken();
  if (!token) {
    console.warn("[Auth] Session token not available for URL");
    return url;
  }

  try {
    // Parse URL (uses origin as base for relative URLs)
    const parsed = new URL(url, window.location.origin);
    parsed.searchParams.set("_token", token);

    // Check if this is a same-origin URL
    if (parsed.origin === window.location.origin) {
      // Same-origin: return relative path (pathname + search)
      return parsed.pathname + parsed.search;
    } else {
      // Cross-origin: preserve the full absolute URL
      return parsed.href;
    }
  } catch {
    // Fallback for unusual URL formats
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}_token=${encodeURIComponent(token)}`;
  }
}

/**
 * Authenticated fetch wrapper.
 * Automatically adds session auth headers to all requests.
 * Use this instead of native fetch for API calls.
 *
 * @param input - URL or Request object
 * @param init - Optional RequestInit configuration
 * @returns Promise<Response>
 */
export function authFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const authHeaders = getAuthHeaders();

  const mergedInit: RequestInit = {
    ...init,
    headers: {
      ...authHeaders,
      ...init?.headers,
    },
  };

  return fetch(input, mergedInit);
}
