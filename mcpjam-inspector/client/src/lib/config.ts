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
 * - ngrok tunneling is disabled (not applicable for web)
 *
 * Set VITE_MCPJAM_HOSTED_MODE=true at build time to enable.
 */
export const HOSTED_MODE = import.meta.env.VITE_MCPJAM_HOSTED_MODE === "true";

/**
 * Controls redaction for live OAuth trace rendering.
 * Redirect resume state and saved app state remain stripped/redacted separately.
 */
export const SANITIZE_OAUTH_TRACES = HOSTED_MODE;

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
