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
import { getConvexSiteUrl } from "@/lib/convex-site-url";
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
  const hostedHeaders =
    hostedAuthorizationHeader && shouldAttachHostedAuthorization(input)
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

function resolveRequestUrl(input: RequestInfo | URL): URL | null {
  const baseOrigin =
    typeof window !== "undefined" ? window.location.origin : "http://localhost";
  try {
    return input instanceof URL
      ? input
      : typeof Request !== "undefined" && input instanceof Request
      ? new URL(input.url, baseOrigin)
      : new URL(String(input), baseOrigin);
  } catch {
    return null;
  }
}

// The session token is a single-process secret for the local CLI/Inspector
// build; only attach it to loopback `/api/*` calls. Non-hosted Inspector is
// not supported behind a public origin — relaxing this would expose the token
// to any reachable client.
function shouldAttachSessionHeaders(input: RequestInfo | URL): boolean {
  if (HOSTED_MODE) {
    return false;
  }

  const parsed = resolveRequestUrl(input);
  if (parsed) {
    return isLoopbackHostname(parsed.hostname) && parsed.pathname.startsWith("/api/");
  }
  return typeof input === "string" && input.startsWith("/api/");
}

// Paths that need the hosted (Convex) Authorization bearer attached. In
// hosted mode every `/api/web/*` route is Convex-backed; in local mode the
// inspector forwards the bearer for routes that re-call Convex
// (`/web/authorize-batch-local`, OAuth bookkeeping). Anything not listed
// here — `/api/session-token`, `/api/health`, the local-only MCP read paths
// — does NOT participate in Convex auth, so we don't want to mint or refresh
// a guest session for those calls.
//
// `/api/web/*` paths are same-origin (proxied by the inspector's own Hono
// server). The `/web/oauth/` paths cover absolute Convex HTTP-action URLs
// (`https://*.convex.site/web/oauth/...`) that the OAuth flow hits directly
// — gated by the same-origin/Convex-host check below so the bearer never
// crosses to a foreign origin.
const HOSTED_AUTH_PATH_PREFIXES = [
  "/api/web/",
  // Local resolver path that calls Convex /web/authorize-batch-local.
  "/api/mcp/connect",
  "/api/mcp/servers/reconnect",
  // Convex HTTP actions called via absolute URL (OAuth completion, etc.).
  "/web/oauth/",
];

/**
 * Returns true when `parsed` is safe to receive a hosted Authorization
 * header — same origin as the app, a loopback host, or the configured
 * Convex `*.convex.site` hostname. Without this, an absolute foreign URL
 * matching one of the path prefixes would receive the bearer (credential
 * exfiltration risk).
 */
function isHostedAuthAllowedOrigin(parsed: URL): boolean {
  if (
    typeof window !== "undefined" &&
    parsed.origin === window.location.origin
  ) {
    return true;
  }
  if (isLoopbackHostname(parsed.hostname)) return true;
  const convexSite = getConvexSiteUrl();
  if (convexSite) {
    try {
      const convexHost = new URL(convexSite).hostname;
      if (parsed.hostname === convexHost) return true;
    } catch {
      // Malformed configured URL — fall through to deny.
    }
  }
  return false;
}

function pathMatchesHostedPrefix(pathname: string): boolean {
  return HOSTED_AUTH_PATH_PREFIXES.some((prefix) => {
    if (prefix.endsWith("/")) return pathname.startsWith(prefix);
    // Non-trailing-slash entries match the literal path AND any sub-path
    // (`/api/mcp/connect`, `/api/mcp/connect/`, `/api/mcp/connect/foo`) so a
    // browser/proxy normalization or future sub-route doesn't silently drop
    // the bearer. `/api/mcp/connecting` still won't match — boundary is `/`.
    return pathname === prefix || pathname.startsWith(`${prefix}/`);
  });
}

function shouldAttachHostedAuthorization(input: RequestInfo | URL): boolean {
  const parsed = resolveRequestUrl(input);
  // Relative paths starting with "/" resolve same-origin via resolveRequestUrl
  // (which uses window.location.origin). For odd inputs that don't parse,
  // fall back to a literal pathname match — but only for relative paths,
  // since an unparseable absolute URL shouldn't get credentials.
  if (parsed) {
    if (!isHostedAuthAllowedOrigin(parsed)) return false;
    return pathMatchesHostedPrefix(parsed.pathname);
  }
  if (typeof input !== "string" || !input.startsWith("/")) return false;
  const pathname = input.split("?")[0];
  return pathMatchesHostedPrefix(pathname);
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
  const callerProvidedAuthorization = hasAuthorizationHeader(init?.headers);
  // Only resolve the hosted bearer for paths that actually call Convex on
  // the user's behalf. Skipping this for unrelated local paths
  // (`/api/session-token`, `/api/health`, local-only MCP read paths) means
  // those calls don't block on minting a guest session at cold boot and
  // don't trigger guest refresh on unrelated 401s.
  const hostedAuthEligible = shouldAttachHostedAuthorization(input);
  const hostedAuthHeader = hostedAuthEligible
    ? await getHostedAuthorizationHeader()
    : null;
  const mergedInit = buildAuthFetchInit(input, init, hostedAuthHeader);
  const response = await fetch(input, mergedInit);

  // Retry on 401 only for paths we actually attached a hosted bearer to —
  // a 401 from `/api/health` shouldn't trigger a guest-session refresh.
  // Also skip when the server flagged the 401 as OAuth-required: that's the
  // upstream MCP server demanding the user complete its OAuth flow, not a
  // session-auth failure, and a guest refresh would just hit the same 401.
  if (
    response.status !== 401 ||
    !hostedAuthEligible ||
    !shouldRetryHostedAuth401() ||
    callerProvidedAuthorization ||
    response.headers?.get("X-MCP-Auth-Required") === "oauth"
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
