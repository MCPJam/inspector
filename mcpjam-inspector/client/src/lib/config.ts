/**
 * Client configuration
 *
 * Environment-based configuration that's determined at build time.
 * Uses Vite's import.meta.env for static replacement.
 */

/**
 * Hosted mode for cloud deployments (Railway, etc.)
 * When enabled:
 * - STDIO connections are disabled (security: prevents RCE)
 * - Only HTTPS connections are allowed
 * - tunneling is disabled (not applicable for web)
 *
 * Set VITE_MCPJAM_HOSTED_MODE=true at build time to enable.
 */
export const HOSTED_MODE = import.meta.env.VITE_MCPJAM_HOSTED_MODE === "true";

/**
 * Controls redaction for live OAuth trace rendering.
 * Redirect resume state and saved app state remain stripped/redacted separately.
 */
export const SANITIZE_OAUTH_TRACES = HOSTED_MODE;

/**
 * Origin to serve the MCP Apps sandbox proxy from in hosted mode. Must be
 * a distinct origin from the host app (different eTLD+1 or at minimum a
 * different registrable subdomain that does not share cookies),
 * e.g. `https://sandbox.mcpjam.com`.
 *
 * Set via `VITE_MCPJAM_SANDBOX_ORIGIN` at build time. The configured origin
 * must serve the same sandbox-proxy route the host app serves at
 * `/api/web/apps/mcp-apps/sandbox-proxy`, and its
 * `frame-ancestors` CSP must include the host app origin (the existing
 * `buildFrameAncestors()` includes every `https://` origin from
 * `CORS_ORIGINS`, so adding the app origin to `CORS_ORIGINS` is enough).
 *
 * When unset in hosted mode, the iframe falls back to same-origin and a
 * console warning is emitted — this is a security regression, not the
 * intended deploy.
 */
export const SANDBOX_ORIGIN: string | null = (() => {
  const raw = import.meta.env.VITE_MCPJAM_SANDBOX_ORIGIN;
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
})();

export const NON_PROD_LOCKDOWN =
  import.meta.env.VITE_MCPJAM_NONPROD_LOCKDOWN === "true";

export const EMPLOYEE_EMAIL_DOMAINS = (
  import.meta.env.VITE_MCPJAM_EMPLOYEE_EMAIL_DOMAINS ?? ""
)
  .split(",")
  .map((domain) => domain.trim().toLowerCase())
  .filter((domain) => domain.length > 0);

export function isAllowedEmployeeEmail(
  email: string | null | undefined,
): boolean {
  if (!email || EMPLOYEE_EMAIL_DOMAINS.length === 0) {
    return false;
  }

  const normalizedEmail = email.trim().toLowerCase();
  const atIndex = normalizedEmail.lastIndexOf("@");
  if (atIndex === -1) {
    return false;
  }

  return EMPLOYEE_EMAIL_DOMAINS.includes(normalizedEmail.slice(atIndex + 1));
}
