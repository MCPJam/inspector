/**
 * Session Token Module
 *
 * Handles authentication token management for the client.
 * The launcher delivers the token in a private access link. The browser
 * retains it in memory and best-effort origin storage; the API only confirms it.
 *
 * This module provides utilities to:
 * - Initialize the token before any API calls
 * - Get auth headers for fetch requests
 * - Add token to URLs for SSE/EventSource (which can't use headers)
 */

import { HOSTED_MODE } from "@/lib/config";
import {
  getApiAuthorizationHeader,
  renewSessionBearer,
  resetTokenCache,
  shouldRetryApiAuth401,
} from "@/lib/apis/web/context";
import { getConvexSiteUrl } from "@/lib/convex-site-url";
import { forceRefreshGuestSession } from "@/lib/guest-session";
import { track } from "@/lib/analytics";
import {
  isSessionRevokedResponse,
  notifySessionRevoked,
} from "@/lib/auth/session-revoked";

import {
  ACCESS_REQUIRED_EVENT,
  readAccessToken,
  rememberAccessToken,
  isAccessToken,
} from "./access-link";

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
  readonly code?: string;
  readonly restarted: boolean;
  constructor(status: number, code?: string, restarted = false) {
    super(`Failed to get session token: ${status}`);
    this.name = "SessionTokenError";
    this.status = status;
    this.code = code;
    this.restarted = restarted;
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
 * Confirms the access-link credential before the app starts.
 *
 * @returns The session token
 * @throws If token cannot be obtained
 */
export async function confirmAccessToken(
  token: string | null,
): Promise<string> {
  const response = await fetch("/api/session-token", {
    headers: token ? { "X-MCP-Session-Auth": `Bearer ${token}` } : {},
    cache: "no-store",
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new SessionTokenError(response.status, body.code, !!token);
  }
  if (!isAccessToken(token) || (await response.json()).ok !== true) {
    throw new Error("Invalid Inspector access response");
  }
  cachedToken = token;
  rememberAccessToken(token);
  return token;
}

export async function initializeSessionToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  if (!initPromise) {
    initPromise = confirmAccessToken(readAccessToken()).catch((error) => {
      initPromise = null;
      throw error;
    });
  }
  return initPromise;
}

export async function refreshSessionToken(): Promise<string | null> {
  cachedToken = null;
  initPromise = null;
  try {
    return await confirmAccessToken(readAccessToken(true));
  } catch (error) {
    if (
      error instanceof SessionTokenError &&
      error.code === "ACCESS_LINK_REQUIRED"
    ) {
      window.dispatchEvent(
        new CustomEvent(ACCESS_REQUIRED_EVENT, {
          detail: { restarted: error.restarted },
        }),
      );
    }
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
  return readAccessToken() ?? "";
}

/**
 * Check if session token is available.
 *
 * @returns true if token is available
 */
export function hasSessionToken(): boolean {
  return !!getSessionToken();
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

/**
 * May this URL carry the local session token?
 *
 * The token is a single-process secret for the local CLI/Inspector build, and
 * this gate exists so `authFetch` never ships it to a FOREIGN origin (the
 * Convex `*.convex.site` HTTP actions, an absolute URL a caller pasted, a
 * redirect target). It is an exfiltration guard, not a localhost-only rule:
 * the server that issued the token is the only party that should ever see it,
 * and that server is reachable at exactly two places from this page's point of
 * view — a loopback address, or the origin the page itself was served from.
 *
 * Same-origin matters for the self-hosted-over-the-network case
 * (`MCPJAM_ALLOWED_HOSTS`, BB-118): the server issues the token to an
 * allowlisted LAN host, and the page at `http://192.168.1.50:6274` must be
 * able to send it back to `http://192.168.1.50:6274/api/*`. Matching the FULL
 * origin (scheme + host + port), never just the hostname, keeps a different
 * service on the same box (`:9999`) from receiving it. Which hosts may hold
 * the token at all is the server's decision (`mayServeSessionToken`) — a page
 * on an origin the server refused never has a token to attach.
 */
function isSessionTokenOrigin(parsed: URL): boolean {
  if (isLoopbackHostname(parsed.hostname)) return true;
  return (
    typeof window !== "undefined" && parsed.origin === window.location.origin
  );
}

function shouldAttachSessionHeaders(input: RequestInfo | URL): boolean {
  if (HOSTED_MODE) {
    return false;
  }

  const parsed = resolveRequestUrl(input);
  if (parsed) {
    return isSessionTokenOrigin(parsed) && parsed.pathname.startsWith("/api/");
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
  "/api/mcp/webmcp",
  "/api/web/",
  // The first-party UI calling its own public harness endpoint
  // (`/api/v1/harness/:id/builtin-tools`) to list a harness's native tools.
  // `/api/v1/*` is bearer-gated (bearerAuthMiddleware reads `Authorization`),
  // and the UI doesn't otherwise call the public API, so these are the only v1
  // paths that need the user's bearer attached. Scoped path-by-path — not all
  // of `/api/v1/` — so unrelated public-API routes don't get the UI bearer.
  "/api/v1/harness/",
  // The Tools panel and the Raw request preview reading MCPJam's own built-in
  // tool definitions (`/api/v1/built-in-tools/browser/definitions`), so neither
  // has to keep a hand-written copy of schemas built at turn time. Same shape
  // and same reason as the harness catalog above: `requireVerifiedAuth`-gated,
  // so without this entry the fetch ships no `Authorization` at all and 401s —
  // and because the panel soft-fails an unreachable catalog to "no tools", the
  // symptom is a Browser section that silently never appears rather than an
  // error anyone can see.
  "/api/v1/built-in-tools/",
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
  // Every local-browser route mounts bearerAuthMiddleware + requireVerifiedAuth,
  // including status, launch, and activity reads. Local/Electron clients need
  // the account bearer alongside their local session token.
  "/api/mcp/computers/local-browser",
  "/api/mcp/computers/browser-location",
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
  /^\/api\/v1\/projects\/[^/]+\/eval-runs\/[^/]+\/(decision-summary|stage-analytics|route-facts|server-facts)$/,
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
  /^\/api\/v1\/projects\/[^/]+\/eval-runs\/[^/]+\/backtest$/,
  /^\/api\/v1\/projects\/[^/]+\/eval-runs\/[^/]+\/iterations$/,
  // What changed since the previous run. Same grant, same reason as the reads
  // above, and anchored the same way: `compare` is one segment and nothing
  // hangs beneath it.
  /^\/api\/v1\/projects\/[^/]+\/eval-runs\/[^/]+\/compare$/,
  // Stopping a run. The only WRITE among the eval-run entries, and it needs
  // the grant for the same reason the reads do: it goes out through
  // `authFetch`, so without an entry here it ships no `Authorization` and the
  // route answers "Bearer token required" — which reaches the user as a failed
  // cancel on a run that is still burning model spend.
  /^\/api\/v1\/projects\/[^/]+\/eval-runs\/[^/]+\/cancel$/,
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

/**
 * Plugin App routes: the gateway's bearer check is their only 401, so a
 * refused request did nothing and may be sent again.
 */
const SIGN_IN_RENEWABLE_PREFIXES = [
  "/api/web/apps/plugin-instances/",
  "/api/web/plugin-forms/",
] as const;

function isSignInRenewablePath(input: RequestInfo | URL): boolean {
  const parsed = resolveRequestUrl(input);
  const pathname = parsed
    ? parsed.pathname
    : typeof input === "string"
      ? input.split("?")[0]
      : "";
  return SIGN_IN_RENEWABLE_PREFIXES.some((prefix) =>
    pathname.startsWith(prefix),
  );
}

/** A body fetch can send twice (a stream is consumed by the first send). */
function isReplayableBody(body: RequestInit["body"]): boolean {
  return (
    body === undefined ||
    body === null ||
    typeof body === "string" ||
    body instanceof FormData ||
    body instanceof URLSearchParams ||
    body instanceof Blob ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body)
  );
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

    // Same exfiltration guard as `authFetch`: the token only ever travels back
    // to the server that issued it (same origin or loopback). A foreign
    // absolute URL is returned untouched rather than carrying the secret in a
    // query string to another host.
    if (!isSessionTokenOrigin(parsed)) {
      console.warn("[Auth] Refusing to attach session token to foreign origin");
      return url;
    }

    parsed.searchParams.set("_token", token);

    // Check if this is a same-origin URL
    if (parsed.origin === window.location.origin) {
      // Same-origin: return relative path (pathname + search)
      return parsed.pathname + parsed.search;
    } else {
      // Absolute loopback URL: preserve the full absolute URL
      return parsed.href;
    }
  } catch {
    // Fallback for unusual URL formats. `new URL` only throws for values that
    // cannot be absolute (it accepts anything absolute and resolves anything
    // relative), so what lands here is a same-origin relative path.
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}_token=${encodeURIComponent(token)}`;
  }
}

/**
 * Authenticated fetch wrapper.
 * Adds local session auth only for same-origin or loopback `/api/*` requests
 * (see `isSessionTokenOrigin`) and hosted auth where applicable.
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
  const hostedAuthHeader =
    hostedAuthEligible && !callerProvidedAuthorization
      ? await getApiAuthorizationHeader()
      : null;
  const mergedInit = buildAuthFetchInit(input, init, hostedAuthHeader);
  const response = await fetch(input, mergedInit);

  // The session behind this tab's bearer was signed out elsewhere (MJ-011).
  // No retry below can help — a fresh token for the same session is refused
  // the same way, and swapping in a guest bearer would be wrong — so report
  // it (the tab signs out once; see `session-revoked.ts`) and hand the
  // refusal back to the caller.
  if (
    response.status === 401 &&
    hostedAuthEligible &&
    (await isSessionRevokedResponse(response))
  ) {
    notifySessionRevoked();
    return response;
  }

  // A signed-in bearer refused as expired by the gateway, on a route whose
  // only 401 is that refusal (it answers before any handler runs): renew the
  // token once and send the same request again. A second refusal goes back
  // to the caller, which says the sign-in expired.
  if (
    response.status === 401 &&
    hostedAuthEligible &&
    !callerProvidedAuthorization &&
    isSignInRenewablePath(input) &&
    isReplayableBody(init?.body) &&
    response.headers?.get("X-MCP-Auth-Required") !== "oauth"
  ) {
    const renewed = await renewSessionBearer();
    if (renewed) {
      init?.signal?.throwIfAborted();
      return fetch(input, buildAuthFetchInit(input, init, `Bearer ${renewed}`));
    }
  }

  // Only Inspector's own session refusal triggers local recovery. Another tab
  // may have saved a new access link; confirm it before retrying once. Upstream
  // OAuth refusals must not prompt for an Inspector access link.
  if (
    response.status === 401 &&
    shouldAttachSessionHeaders(input) &&
    response.headers?.get("X-MCPJam-Session") != null
  ) {
    const staleToken = getSessionToken();
    const refreshedToken = await refreshSessionToken();
    if (refreshedToken && refreshedToken !== staleToken) {
      const retryInit = buildAuthFetchInit(input, init, hostedAuthHeader);
      const retried = await fetch(input, retryInit);
      if (retried.status === 401 && retried.headers.get("X-MCPJam-Session")) {
        window.dispatchEvent(
          new CustomEvent(ACCESS_REQUIRED_EVENT, {
            detail: { restarted: true },
          }),
        );
      }
      return retried;
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
