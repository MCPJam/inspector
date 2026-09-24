/**
 * Security Headers Middleware
 *
 * Adds security headers to all responses:
 * - X-Content-Type-Options: Prevents MIME type sniffing
 * - X-Frame-Options: Prevents clickjacking
 * - X-XSS-Protection: Enables XSS filter
 * - Referrer-Policy: Controls referrer information
 * - Strict-Transport-Security: HTTPS requests only, see below
 *
 * Note: CSP is intentionally not included as the app integrates with many
 * external services (WorkOS, PostHog, Sentry, Convex, MCP servers with OAuth)
 * that make a restrictive CSP impractical. The primary security controls are
 * session token authentication and origin validation.
 *
 * Permissions-Policy is deliberately not set here either. It ratchets at every
 * iframe boundary: a restrictive header on the document would override the
 * per-resource sandbox grants that `client-preview-iframe-allow.ts` builds, and
 * no descendant iframe could use camera / microphone / clipboard-write however
 * the host config is written. Any policy has to be decided alongside that
 * allowlist rather than bolted on in front of it.
 */

import type { Context, Next } from "hono";

const ONE_YEAR_SECONDS = 31_536_000;

/**
 * Whether the request reached us over HTTPS, trusting `x-forwarded-proto` first
 * because the hosted deployment terminates TLS at the proxy. The header is a
 * comma-separated list when it crosses more than one hop; the client-facing
 * scheme is the first entry.
 */
function isHttpsRequest(c: Context): boolean {
  const forwardedProto = c.req.header("x-forwarded-proto");
  if (forwardedProto) {
    return forwardedProto.split(",")[0]?.trim().toLowerCase() === "https";
  }

  try {
    return new URL(c.req.url).protocol === "https:";
  } catch {
    return false;
  }
}

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

  // Only ever sent over HTTPS. The inspector also runs locally on
  // http://localhost, and a browser that sees HSTS there pins *every* service
  // on localhost to HTTPS — not just this port — which outlives the dev server
  // and is not cleared by reloading.
  //
  // `includeSubDomains` is left off on purpose: it would cover every
  // *.mcpjam.com host, including the tunnel and sandbox subdomains, and one of
  // those not serving HTTPS becomes unreachable for the whole max-age. Widening
  // this, and preload, belong with the edge configuration rather than here.
  if (isHttpsRequest(c)) {
    c.header("Strict-Transport-Security", `max-age=${ONE_YEAR_SECONDS}`);
  }

  return next();
}
