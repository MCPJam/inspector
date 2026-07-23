/**
 * Session Authentication Middleware
 *
 * Requires a valid session token for all API requests (except health checks).
 *
 * Token delivery methods:
 * 1. Header: X-MCP-Session-Auth: Bearer <token> (preferred for fetch API)
 * 2. Query param: ?_token=<token> (required for SSE/EventSource)
 *
 * The query parameter fallback is necessary because the EventSource API
 * does not support custom headers.
 *
 * SECURITY NOTE: When adding new routes, consider whether they should be protected.
 * Only add routes to UNPROTECTED_* if they:
 * - Are public health checks
 * - Are loaded in sandboxed iframes that can't include auth headers
 * - Are static assets that don't expose sensitive data
 */

import type { Context, Next } from "hono";
import { validateToken } from "../services/session-token.js";

/**
 * Routes that don't require authentication.
 *
 * SECURITY: Each route here must have a documented reason for being unprotected.
 */
const UNPROTECTED_ROUTES = [
  "/health", // Health check - no sensitive data
  "/api/mcp/health", // Health check - no sensitive data
  "/api/apps/health", // Health check - no sensitive data
  "/api/session-token", // Token endpoint - protected by localhost check instead
  // Public model catalog proxy: guests fetch it to populate the picker. It
  // forwards no auth and returns only the keyless backend /v1/models (no
  // sensitive data). Without this exemption the client's authless fetch 401s
  // and the picker silently falls back to the static snapshot. EXACT match —
  // it has no sub-paths.
  "/api/mcp/models",
  // Mock OIDC IdP front-channel/RP endpoints: external browsers and relying
  // parties reach these without any MCPJam session (that's their purpose).
  // EXACT matches only — never move these to UNPROTECTED_PREFIXES, where the
  // startsWith match would silently make /api/mcp/xaa/token-exchange public.
  "/api/mcp/xaa/authorize",
  "/api/mcp/xaa/authorize/confirm",
  "/api/mcp/xaa/token",
  "/api/mcp/xaa/userinfo",
];

/**
 * Route prefixes that don't require authentication.
 *
 * SECURITY: Each prefix here must have a documented reason for being unprotected.
 */
const UNPROTECTED_PREFIXES = [
  // NOTE: only /api/* paths need listing here — everything else already
  // bypasses this middleware (see the startsWith("/api/") check below).
  // /relay (the PostHog reverse proxy, routes/relay.ts) relies on that
  // non-/api bypass: analytics must flow before any session exists. It must
  // never be moved under /api/ or it would silently gain session auth.
  "/assets/", // Static assets (JS, CSS, images) - no sensitive data
  "/api/apps/mcp-apps/", // MCP Apps widgets - loaded in sandboxed iframes, can't send headers
  // Widget file DOWNLOAD only. The download URL is fetched directly from
  // inside the sandboxed iframe (img/script/fetch) and can't carry auth
  // headers, so it must be public. Upload is intentionally NOT in this
  // prefix: `POST /api/apps/files/upload-file` is always invoked from the
  // host page (via `authFetch` in widget-file-messages.ts), so it CAN
  // and DOES carry the session token. Keeping upload behind auth blocks
  // unauthenticated callers from filling the in-memory fileStore with up
  // to 20 MB blobs per request.
  "/api/apps/files/file/",
  "/api/mcp/adapter-http/", // HTTP adapter for tunneled MCP clients - auth via URL secrecy
  "/api/mcp/manager-http/", // HTTP manager for tunneled MCP clients - auth via URL secrecy
  "/api/mcp/xaa/.well-known/", // Public XAA issuer discovery + JWKS for external authorization servers
  // CLI OAuth bridge: public front-channel (config metadata + browser
  // redirects through AuthKit). Returns no tokens or sensitive data; the
  // callback's redirect target is integrity-protected by an HMAC-signed
  // state and restricted to loopback (see routes/cli-auth/state.ts).
  "/api/cli/auth/",
];

/**
 * Scrub sensitive tokens from URLs for safe logging.
 * Replaces _token (session token), k (tunnel bearer secret), t (the retired
 * harness `?t=` proxy-token fallback), and token (the computer terminal/
 * upload token — routes/web/computer-terminal.ts takes it from the WS
 * subprotocol only, never `?token=`, but this is scrubbed defensively in
 * case a stale client, a proxy, or a future regression puts one in the URL)
 * query parameter values with [REDACTED].
 */
export function scrubTokenFromUrl(url: string): string {
  return url
    .replace(/([?&])_token=[^&]*/g, "$1_token=[REDACTED]")
    .replace(/([?&])k=[^&]*/g, "$1k=[REDACTED]")
    .replace(/([?&])t=[^&]*/g, "$1t=[REDACTED]")
    .replace(/([?&])token=[^&]*/g, "$1token=[REDACTED]");
}

// Routes that typically use query param auth (SSE endpoints)
const SSE_ROUTES = [
  "/api/mcp/servers/rpc/stream",
  "/api/mcp/elicitation/stream",
  "/api/mcp/adapter-http/",
  "/api/mcp/manager-http/",
];

/**
 * Check if a path is an SSE route (for better error messaging)
 */
function isSSERoute(path: string): boolean {
  return SSE_ROUTES.some((route) => path.startsWith(route));
}

/**
 * Session authentication middleware.
 * Validates the session token from header or query parameter.
 */
export async function sessionAuthMiddleware(
  c: Context,
  next: Next
): Promise<Response | void> {
  const path = c.req.path;
  const method = c.req.method;

  // Allow CORS preflight requests through - they can't include auth headers
  if (method === "OPTIONS") {
    return next();
  }

  // Only protect API routes - static files and HTML pages don't need auth
  // The HTML page is where the token gets injected, so it must be accessible
  if (!path.startsWith("/api/")) {
    return next();
  }

  // Hosted web routes use bearer auth and Convex authorization, not session tokens.
  if (path.startsWith("/api/web/")) {
    return next();
  }

  // Hosted public API (v1) uses bearer auth + Convex authorization, exactly like
  // /api/web/* — its own bearerAuthMiddleware runs in routes/v1. Server-to-server
  // callers (MCP worker, CLI, agents) send `Authorization: Bearer`, not the
  // browser session token, so they must not be gated by session auth here.
  if (path.startsWith("/api/v1/")) {
    return next();
  }

  // Allow unprotected API routes without auth
  if (UNPROTECTED_ROUTES.some((route) => path === route)) {
    return next();
  }

  // Allow unprotected prefixes without auth
  if (UNPROTECTED_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return next();
  }

  // Extract token from header (preferred)
  let token: string | undefined;
  const authHeader = c.req.header("X-MCP-Session-Auth");

  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.substring(7);
  }

  // Fall back to query parameter (required for SSE/EventSource)
  if (!token) {
    token = c.req.query("_token") ?? undefined;
  }

  // No token provided
  if (!token) {
    return c.json(
      {
        error: "Unauthorized",
        message: "Session token required.",
        hint: isSSERoute(path)
          ? "SSE endpoints require ?_token=<token> query parameter"
          : "Include X-MCP-Session-Auth: Bearer <token> header",
      },
      401
    );
  }

  // Invalid token
  if (!validateToken(token)) {
    return c.json(
      {
        error: "Unauthorized",
        message: "Invalid session token.",
        hint: "Try refreshing the page to get a new token.",
      },
      401
    );
  }

  return next();
}
