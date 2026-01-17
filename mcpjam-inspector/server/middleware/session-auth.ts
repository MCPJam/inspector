/**
 * Session Authentication Middleware
 *
 * Primary security control for CVE-2026-23744 and CVE-2025-49596.
 * Requires a valid session token for all API requests (except health checks).
 *
 * Token delivery methods:
 * 1. Header: X-MCP-Session-Auth: Bearer <token> (preferred for fetch API)
 * 2. Query param: ?_token=<token> (required for SSE/EventSource)
 *
 * The query parameter fallback is necessary because the EventSource API
 * does not support custom headers.
 */

import type { Context, Next } from "hono";
import { validateToken } from "../services/session-token.js";

// Routes that don't require authentication
const UNPROTECTED_ROUTES = [
  "/health",
  "/api/mcp/health",
  "/api/apps/health",
  "/api/session-token",
];

// Prefixes for routes that don't require authentication
const UNPROTECTED_PREFIXES = [
  "/assets/", // Static assets (JS, CSS, images)
  "/api/mcp/oauth/", // OAuth proxy endpoints (auth handled by OAuth protocol)
  "/api/mcp/apps/", // MCP Apps endpoints (widgets loaded in sandboxed iframes)
  "/api/apps/chatgpt/", // ChatGPT apps endpoints (widgets loaded in sandboxed iframes)
  "/api/mcp/sandbox-proxy", // Sandbox proxy for widget isolation
];

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
