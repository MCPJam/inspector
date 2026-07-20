/**
 * Security Headers Middleware
 *
 * Adds security headers to all responses:
 * - X-Content-Type-Options: Prevents MIME type sniffing
 * - X-Frame-Options: Prevents clickjacking
 * - X-XSS-Protection: Enables XSS filter
 * - Referrer-Policy: Controls referrer information
 * - X-Robots-Tag: Keeps the authenticated app shell out of search indexes
 *   (the SPA catch-all serves 200s for every path, so without this crawlers
 *   would index every route; crawling stays allowed via robots.txt so
 *   robots can actually see this directive)
 *
 * Note: CSP is intentionally not included as the app integrates with many
 * external services (WorkOS, PostHog, Sentry, Convex, MCP servers with OAuth)
 * that make a restrictive CSP impractical. The primary security controls are
 * session token authentication and origin validation.
 */

import type { Context, Next } from "hono";

/**
 * Security headers middleware.
 * Adds standard security headers to all responses.
 */
export async function securityHeadersMiddleware(
  c: Context,
  next: Next,
): Promise<Response | void> {
  // Security headers (no CSP - too many external integrations)
  c.header("X-Content-Type-Options", "nosniff");
  // Use SAMEORIGIN instead of DENY to allow widget sandboxed iframes
  c.header("X-Frame-Options", "SAMEORIGIN");
  c.header("X-XSS-Protection", "1; mode=block");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  // Authenticated app shell — not indexable content (see robots.txt note above)
  c.header("X-Robots-Tag", "noindex");

  return next();
}
