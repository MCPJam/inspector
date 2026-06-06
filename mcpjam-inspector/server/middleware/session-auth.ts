/**
 * Session Authentication Middleware
 *
 * Requires a valid session token for all API requests (except health checks).
 *
 * Token delivery methods:
 * 1. Header: X-MCP-Session-Auth: Bearer <token> (preferred for fetch API)
 * 2. Cookie: mcp_session_auth=<token> (used for same-origin SSE/EventSource)
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
];

/**
 * Route prefixes that don't require authentication.
 *
 * SECURITY: Each prefix here must have a documented reason for being unprotected.
 */
const UNPROTECTED_PREFIXES = [
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
];

/**
 * Scrub sensitive tokens from URLs for safe logging.
 * Replaces legacy _token query parameter values with [REDACTED].
 */
export function scrubTokenFromUrl(url: string): string {
  return url.replace(/([?&])_token=[^&]*/g, "$1_token=[REDACTED]");
}

// Routes that typically use EventSource/SSE auth
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
 * Validates the session token from header or same-origin cookie.
 */
export async function sessionAuthMiddleware(
  c: Context,
  next: Next,
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

  // Fall back to a same-origin cookie for SSE/EventSource, which cannot set
  // custom headers. Avoid accepting tokens in URLs because query parameters
  // are commonly captured by browser history, referrer headers, and logs.
  if (!token) {
    token = c.req
      .header("Cookie")
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("mcp_session_auth="))
      ?.substring("mcp_session_auth=".length);
  }

  // No token provided
  if (!token) {
    return c.json(
      {
        error: "Unauthorized",
        message: "Session token required.",
        hint: isSSERoute(path)
          ? "SSE endpoints require the mcp_session_auth cookie"
          : "Include X-MCP-Session-Auth: Bearer <token> header",
      },
      401,
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
      401,
    );
  }

  return next();
}
