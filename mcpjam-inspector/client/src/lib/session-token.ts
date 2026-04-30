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

import { HOSTED_MODE } from "@/lib/config";
import {
  getHostedAuthorizationHeader,
  resetTokenCache,
  shouldRetryHostedAuth401,
} from "@/lib/apis/web/context";
import { forceRefreshGuestSession } from "@/lib/guest-session";
import posthog from "posthog-js";

// Extend window type for the injected token
declare global {
  interface Window {
    __MCP_SESSION_TOKEN__?: string;
  }
}

let cachedToken: string | null = null;
let initPromise: Promise<string> | null = null;

type AuthFetchSurface = "chatbox";

const AUTH_FETCH_SURFACE_BY_PATH: Record<string, AuthFetchSurface> = {
  "/api/web/chatboxes/bootstrap": "chatbox",
};

function resolveAuthFetchSurface(
  input: RequestInfo | URL
): AuthFetchSurface | null {
  const rawUrl =
    input instanceof URL
      ? input.toString()
      : typeof Request !== "undefined" && input instanceof Request
      ? input.url
      : String(input);
  const baseOrigin =
    typeof window !== "undefined" ? window.location.origin : "http://localhost";

  try {
    const parsed = new URL(rawUrl, baseOrigin);
    return AUTH_FETCH_SURFACE_BY_PATH[parsed.pathname] ?? null;
  } catch {
    return AUTH_FETCH_SURFACE_BY_PATH[rawUrl] ?? null;
  }
}

function mergeHeaders(
  ...headersList: Array<HeadersInit | undefined>
): HeadersInit {
  const merged: Record<string, string> = {};

  for (const headers of headersList) {
    if (!headers) continue;

    if (headers instanceof Headers) {
      headers.forEach((value, key) => {
        merged[key] = value;
      });
      continue;
    }

    if (Array.isArray(headers)) {
      for (const [key, value] of headers) {
        merged[key] = value;
      }
      continue;
    }

    Object.assign(merged, headers);
  }

  return merged;
}

function hasAuthorizationHeader(headers?: HeadersInit): boolean {
  if (!headers) return false;

  if (headers instanceof Headers) {
    return headers.has("Authorization");
  }

  if (Array.isArray(headers)) {
    return headers.some(([key]) => key.toLowerCase() === "authorization");
  }

  return Object.keys(headers).some(
    (key) => key.toLowerCase() === "authorization"
  );
}

function buildAuthFetchInit(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  hostedAuthorizationHeader: string | null
): RequestInit {
  const sessionHeaders = shouldAttachSessionHeaders(input)
    ? getAuthHeaders()
    : undefined;
  const hostedHeaders = hostedAuthorizationHeader
    ? ({ Authorization: hostedAuthorizationHeader } as HeadersInit)
    : undefined;

  return {
    ...init,
    headers: mergeHeaders(sessionHeaders, hostedHeaders, init?.headers),
  };
}

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
  if (HOSTED_MODE) {
    return {};
  }

  const token = getSessionToken();
  if (!token) {
    console.warn("[Auth] Session token not available");
    return {};
  }
  return { "X-MCP-Session-Auth": `Bearer ${token}` };
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

// The session token is a single-process secret for the local CLI/Inspector
// build; only attach it to loopback `/api/*` calls. Non-hosted Inspector is
// not supported behind a public origin — relaxing this would expose the token
// to any reachable client.
function shouldAttachSessionHeaders(input: RequestInfo | URL): boolean {
  if (HOSTED_MODE) {
    return false;
  }

  const baseOrigin =
    typeof window !== "undefined" ? window.location.origin : "http://localhost";

  try {
    const parsed =
      input instanceof URL
        ? input
        : typeof Request !== "undefined" && input instanceof Request
          ? new URL(input.url, baseOrigin)
          : new URL(String(input), baseOrigin);

    return isLoopbackHostname(parsed.hostname) && parsed.pathname.startsWith("/api/");
  } catch {
    return typeof input === "string" && input.startsWith("/api/");
  }
}

/**
 * Add token to URL as query parameter.
 * Required for SSE/EventSource which doesn't support custom headers.
 *
 * @param url - The URL to add token to (can be relative or absolute)
 * @returns URL with token as query parameter
 */
export function addTokenToUrl(url: string): string {
  if (HOSTED_MODE) {
    return url;
  }

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
 * Adds local session auth only for loopback `/api/*` requests and hosted auth
 * where applicable.
 * Use this instead of native fetch for API calls.
 *
 * @param input - URL or Request object
 * @param init - Optional RequestInit configuration
 * @returns Promise<Response>
 */
export async function authFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const surface = resolveAuthFetchSurface(input);
  const hostedAuthHeader = await getHostedAuthorizationHeader();
  const callerProvidedAuthorization = hasAuthorizationHeader(init?.headers);
  const mergedInit = buildAuthFetchInit(input, init, hostedAuthHeader);
  const response = await fetch(input, mergedInit);

  if (
    response.status !== 401 ||
    !HOSTED_MODE ||
    !shouldRetryHostedAuth401() ||
    callerProvidedAuthorization
  ) {
    return response;
  }

  // Clear both the 30s bearer cache and the stale guest token,
  // then fetch a fresh guest token and retry once.
  resetTokenCache();
  const refreshedGuestToken = await forceRefreshGuestSession();
  if (!refreshedGuestToken) {
    if (surface) {
      posthog.capture("guest_refresh_failure", {
        surface,
        auth_mode: "guest",
        status: "failure",
        error_kind: "guest_refresh_unavailable",
      });
    }
    return response;
  }

  if (surface) {
    posthog.capture("guest_refresh_success", {
      surface,
      auth_mode: "guest",
      status: "success",
    });
  }

  const retryInit = buildAuthFetchInit(
    input,
    init,
    `Bearer ${refreshedGuestToken}`,
  );
  return fetch(input, retryInit);
}
