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

/**
 * The Discord application the agent bot runs as, used to build the "add to
 * server" URL on the Integrations page.
 *
 * A Discord client id is a public identifier — it travels in every install
 * URL — but it is deployment-specific, so it is configured rather than
 * hardcoded. When unset the Discord card does not render: an install link
 * built from a missing id sends people to a Discord error page, which reads
 * as our bug rather than as missing configuration.
 *
 * Set via `VITE_MCPJAM_DISCORD_CLIENT_ID` at build time.
 */
export const DISCORD_CLIENT_ID: string | null = (() => {
  const raw = import.meta.env.VITE_MCPJAM_DISCORD_CLIENT_ID;
  return typeof raw === "string" && /^\d+$/.test(raw.trim())
    ? raw.trim()
    : null;
})();

/**
 * Permissions the bot actually uses, and nothing else: View Channels (without
 * it a mention never arrives), Send Messages, Attach Files (run evidence), and
 * Read Message History (thread context).
 */
const DISCORD_BOT_PERMISSIONS = String(
  (1 << 10) | (1 << 11) | (1 << 15) | (1 << 16),
);

/**
 * Where "Add to Discord" goes. `bot` puts the bot user in the server;
 * `applications.commands` is what lets `/mcpjam connect` register — without
 * it the app installs but the command never appears.
 */
export function discordInstallUrl(): string | null {
  if (!DISCORD_CLIENT_ID) return null;
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    scope: "bot applications.commands",
    permissions: DISCORD_BOT_PERMISSIONS,
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}
