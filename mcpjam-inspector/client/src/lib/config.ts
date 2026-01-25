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
