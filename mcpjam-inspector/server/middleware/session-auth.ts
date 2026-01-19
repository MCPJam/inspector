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
];

/**
 * Route prefixes that don't require authentication.
 *
 * SECURITY: Each prefix here must have a documented reason for being unprotected.
 */
const UNPROTECTED_PREFIXES = [
  "/assets/", // Static assets (JS, CSS, images) - no sensitive data
  "/api/mcp/apps/", // MCP Apps widgets - loaded in sandboxed iframes, can't send headers
  "/api/apps/chatgpt/", // ChatGPT widgets - loaded in sandboxed iframes, can't send headers
  "/api/mcp/sandbox-proxy", // Sandbox proxy - loaded in iframe, serves isolated content
];

/**
 * Scrub sensitive tokens from URLs for safe logging.
 * Replaces _token query parameter values with [REDACTED].
 */
export function scrubTokenFromUrl(url: string): string {
  return url.replace(/([?&])_token=[^&]*/g, "$1_token=[REDACTED]");
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
