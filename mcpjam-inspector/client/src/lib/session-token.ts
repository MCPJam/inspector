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
  getApiAuthorizationHeader,
  resetTokenCache,
  shouldRetryApiAuth401,
} from "@/lib/apis/web/context";
import { getConvexSiteUrl } from "@/lib/convex-site-url";
import { forceRefreshGuestSession } from "@/lib/guest-session";
import { track } from "@/lib/analytics";

// Extend window type for the injected token
declare global {
  interface Window {
    __MCP_SESSION_TOKEN__?: string;
  }
}

let cachedToken: string | null = null;
let initPromise: Promise<string> | null = null;

/**
 * Error thrown when `/api/session-token` responds non-OK, carrying the HTTP
 * status so the bootstrap can tell the EXPECTED host-denial (403) apart from a
 * genuine failure.
 *
 * A 403 here is not a bug: the server withholds the token from any host that
 * isn't localhost or in `MCPJAM_ALLOWED_HOSTS` (see server/utils/localhost-check.ts).
 * A self-hosted user reaching the inspector over the network hits exactly this,
 * and it has a self-service fix (allowlist their host) — so it gets a tailored
 * screen and is NOT reported to Sentry, unlike a real 5xx/transport failure.
 */
export class SessionTokenError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Failed to get session token: ${status}`);
    this.name = "SessionTokenError";
    this.status = status;
  }
}

/**
 * Whether `error` is the expected "host not allowed" session-token denial (403).
 * These are self-inflicted-by-config, not defects: the caller renders guidance
 * instead of a generic error and skips error reporting.
 */
export function isSessionTokenHostDenied(error: unknown): boolean {
  return error instanceof SessionTokenError && error.status === 403;
}

type AuthFetchSurface = "scenario";

const AUTH_FETCH_SURFACE_BY_PATH: Record<string, AuthFetchSurface> = {
  "/api/web/scenarios/bootstrap": "scenario",
};

function resolveAuthFetchSurface(
  input: RequestInfo | URL,
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
    (key) => key.toLowerCase() === "authorization",
  );
}

function buildAuthFetchInit(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  hostedAuthorizationHeader: string | null,
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
          throw new SessionTokenError(response.status);
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
 * Force a re-fetch of the dev session token.
 *
 * The local backend mints a fresh session token on every restart (see
 * `services/session-token.ts#generateSessionToken`). After a dev-server
 * restart the browser still holds the token cached at page load, so every
 * `/api/*` call 401s until a hard refresh. Clearing the cache and re-fetching
 * recovers transparently.
 *
 * In production the token is injected into the HTML and can't be refreshed at
 * runtime, so the injected value is returned as-is.
 *
 * @returns The refreshed token, or null if it couldn't be obtained.
 */
export async function refreshSessionToken(): Promise<string | null> {
  if (window.__MCP_SESSION_TOKEN__) {
    cachedToken = window.__MCP_SESSION_TOKEN__;
    return cachedToken;
  }

  // Drop the stale cache + any in-flight init so initializeSessionToken
  // actually hits /api/session-token again instead of returning the old token.
  cachedToken = null;
  initPromise = null;

  try {
    return await initializeSessionToken();
  } catch {
    return null;
  }
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
    return (
      isLoopbackHostname(parsed.hostname) && parsed.pathname.startsWith("/api/")
    );
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
  // The first-party UI calling its own public harness endpoint
  // (`/api/v1/harness/:id/builtin-tools`) to list a harness's native tools.
  // `/api/v1/*` is bearer-gated (bearerAuthMiddleware reads `Authorization`),
  // and the UI doesn't otherwise call the public API, so these are the only v1
  // paths that need the user's bearer attached. Scoped path-by-path — not all
  // of `/api/v1/` — so unrelated public-API routes don't get the UI bearer.
  "/api/v1/harness/",
  // The org-settings Capabilities page reading the agent's op registry, so its
  // toggles cannot drift from the tools the server actually offers.
  "/api/v1/agent-ops",
  // Local-harness control routes. These are `requireVerifiedAuth()`-gated and
  // one of them (consent grant) forwards the bearer to Convex to register this
  // installation's instance key — so without this entry a signed-in user gets a
  // 401 on every one of them, which is the exact bug PR #4515 shipped once.
  "/api/mcp/local-harness",
  // Local resolver path that calls Convex /web/authorize-batch-local.
  "/api/mcp/connect",
  "/api/mcp/servers/reconnect",
  // Local chat re-calls Convex for host/scenario runtime config and
  // persistence, so resolve its bearer at request time as well.
  "/api/mcp/chat-v2",
  // Local XAA proxy paths whose server-target / registration runs resolve a
  // Convex-stored secret on the user's behalf (the hosted `/api/web/xaa/*`
  // equivalents are already covered by the `/api/web/` prefix above).
  "/api/mcp/xaa/proxy/token",
  "/api/mcp/xaa/negative-tests",
  // Local XAA mint paths for the "use hosted issuer" opt-in: the local
  // server forwards these to app.mcpjam.com with the caller's bearer.
  // Attaching via authFetch (rather than injecting the header manually) keeps
  // the on-401 bearer-refresh-and-retry so a stale/expired hosted token
  // self-heals instead of stranding the flow until a page refresh. Harmless
  // in pure-local mode: the local mint ignores the header.
  "/api/mcp/xaa/authenticate",
  "/api/mcp/xaa/token-exchange",
  // The standards-track RFC 8693 grant the debugger drives on the happy path;
  // needs the bearer for the hosted-issuer forward (harmless locally).
  // Boundary matching keeps this from also matching /token-exchange.
  "/api/mcp/xaa/token",
  // Local-computer consent capability (grant/verify/revoke): the routes mount
  // `requireVerifiedAuth`, so they need the user's WorkOS bearer. Attaching
  // via authFetch (not a manual header) keeps the on-401 session-token refresh
  // so a dev-server restart doesn't strand consent at 401 until a page reload.
  "/api/mcp/computers/local-consent",
  // The local-terminal nonce mint mounts the same bearerAuthMiddleware +
  // `requireVerifiedAuth` stack as the consent routes, so it needs the user's
  // bearer for the same reason — without it the mint 401s on the missing
  // bearer before the consent check ever runs, and the terminal can never
  // open on a WorkOS-signed-in inspector.
  "/api/mcp/computers/local-terminal-token",
  // Convex HTTP actions called via absolute URL (OAuth completion, etc.).
  "/web/oauth/",
  // Registry catalog/star routes are Convex HTTP actions called via absolute
  // URL, and every one of them requires an identity (the catalog resolves
  // per-viewer `isStarred`). Without this prefix the bearer is never attached
  // and they all 401 with "Missing or invalid bearer token".
  "/web/registry/",
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

/**
 * Paths whose SCOPE sits in the middle, so no prefix can name them.
 *
 * `/api/v1/projects/{projectId}/readiness-runs...` and its server-scoped start
 * carry ids the UI substitutes at call time, and the interesting segment comes
 * after them. The alternative was the prefix `/api/v1/projects/`, which would
 * hand the user's bearer to every project-scoped public-API route that ever
 * ships — the exact opposite of the path-by-path scoping the list above
 * exists to maintain. A pattern keeps the grant as narrow as the prefixes are.
 *
 * Anchored at both ends, and the id segments match one segment each: nothing
 * with an extra path component can slip through.
 */
const HOSTED_AUTH_PATH_PATTERNS = [
  // The /conformance page starting, polling, cancelling and reading a
  // directory-readiness run.
  /^\/api\/v1\/projects\/[^/]+\/readiness-runs(\/[^/]+(\/(cancel|report))?)?$/,
  /^\/api\/v1\/projects\/[^/]+\/servers\/[^/]+\/readiness-runs\/(claude|openai)$/,
  // The pre-run eval disclosure (G4b). Deliberate, anchored bearer-scope
  // change: without this entry the UI's hint would silently 401, since
  // `/api/v1/projects/` is not a prefix this list grants wholesale — see the
  // module header on why a pattern, not a prefix, is what keeps the grant as
  // narrow as the id segments in the middle.
  /^\/api\/v1\/projects\/[^/]+\/eval-suites\/[^/]+\/run-disclosure$/,
  // The Evaluate (New) chain reads: D9's decision summary and D5c's stage
  // analytics, suite-paged and run-scoped. Same anchored bearer-scope grant as
  // the disclosure above, and needed for the same reason — both go out through
  // `authFetch`, so without an entry here they ship no `Authorization` at all
  // and the route answers "Bearer token required". That 401 surfaces as
  // `requestFailed`/service copy ("could not be loaded"), which reads as a
  // backend outage rather than a missing header, so the panels look broken
  // while the API is fine.
  /^\/api\/v1\/projects\/[^/]+\/eval-runs\/[^/]+\/(decision-summary|stage-analytics|route-facts)$/,
  /^\/api\/v1\/projects\/[^/]+\/eval-suites\/[^/]+\/stage-analytics$/,
  // Description-experiment reads and the two writes the Evaluate card
  // issues through authFetch (propose + start). Anchored the same way as
  // route-facts: id segments in the middle, no blanket /eval- prefix.
  /^\/api\/v1\/projects\/[^/]+\/eval-runs\/[^/]+\/description-experiments$/,
  /^\/api\/v1\/projects\/[^/]+\/eval-description-experiments\/[^/]+(\/start)?$/,
  // One page of a run's iterations, each carrying its own stage rows — the
  // only read that covers a PASSING trial's chain, which D9's diagnostics
  // exclude by contract.
  //
  // Anchored at `iterations` on purpose: the trace and the per-iteration
  // resource beneath it are a transcript and a row, read elsewhere with their
  // own auth, and a pattern that swallowed them would be the blanket prefix
  // this list exists to avoid. The eval-chain test pins all three.
  /^\/api\/v1\/projects\/[^/]+\/eval-runs\/[^/]+\/iterations$/,
  // What changed since the previous run. Same grant, same reason as the reads
  // above, and anchored the same way: `compare` is one segment and nothing
  // hangs beneath it.
  /^\/api\/v1\/projects\/[^/]+\/eval-runs\/[^/]+\/compare$/,
];

function pathMatchesHostedPrefix(pathname: string): boolean {
  if (HOSTED_AUTH_PATH_PATTERNS.some((pattern) => pattern.test(pathname))) {
    return true;
  }
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
  init?: RequestInit,
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
    ? await getApiAuthorizationHeader()
    : null;
  const mergedInit = buildAuthFetchInit(input, init, hostedAuthHeader);
  const response = await fetch(input, mergedInit);

  // Local session-token recovery (non-hosted). The dev backend regenerates its
  // session token on every restart; if it restarted since page load the
  // browser holds a stale token and each /api/* call 401s with a cryptic
  // "Backend debug proxy error: 401 Unauthorized" until a manual page refresh.
  // Re-fetch the current token and retry once so a backend restart doesn't
  // strand the session. Skipped when the caller set its own Authorization, and
  // when the 401 is the upstream MCP server demanding OAuth (refreshing the
  // session token wouldn't change that outcome).
  if (
    response.status === 401 &&
    shouldAttachSessionHeaders(input) &&
    !callerProvidedAuthorization &&
    response.headers?.get("X-MCP-Auth-Required") !== "oauth"
  ) {
    const staleToken = getSessionToken();
    const refreshedToken = await refreshSessionToken();
    if (refreshedToken && refreshedToken !== staleToken) {
      const retryInit = buildAuthFetchInit(input, init, hostedAuthHeader);
      return fetch(input, retryInit);
    }
  }

  // Retry on 401 only for paths we actually attached a hosted bearer to —
  // a 401 from `/api/health` shouldn't trigger a guest-session refresh.
  // Also skip when the server flagged the 401 as OAuth-required: that's the
  // upstream MCP server demanding the user complete its OAuth flow, not a
  // session-auth failure, and a guest refresh would just hit the same 401.
  if (
    response.status !== 401 ||
    !hostedAuthEligible ||
    !shouldRetryApiAuth401() ||
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
      track("guest_refresh_failure", {
        location: "auth_fetch",
        surface,
        auth_mode: "guest",
        status: "failure",
        error_kind: "guest_refresh_unavailable",
      });
    }
    return response;
  }

  if (surface) {
    track("guest_refresh_success", {
      location: "auth_fetch",
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
