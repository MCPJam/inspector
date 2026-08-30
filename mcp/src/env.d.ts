// Secrets live outside `wrangler.jsonc` vars (set via `wrangler secret put`),
// so `wrangler types` does not emit them into `worker-configuration.d.ts`.
// Declaration-merge them onto the global `Env` here so they survive type
// regeneration.
interface Env {
  /**
   * Shared secret presented to the inspector guest-mint route as
   * `x-inspector-service-token` (matches the inspector's
   * `INSPECTOR_SERVICE_TOKEN`). Set with `wrangler secret put
   * MCPJAM_INSPECTOR_SERVICE_TOKEN --env <env>`.
   */
  MCPJAM_INSPECTOR_SERVICE_TOKEN?: string;

  /**
   * Killswitch toggle (runtime var / dashboard secret, not in wrangler.jsonc).
   * When "true", the worker is AuthKit-only: guest tokens are rejected and
   * anonymous (tokenless) /mcp connections get the normal 401 → OAuth
   * challenge.
   */
  MCPJAM_NONPROD_LOCKDOWN?: string;

  /**
   * The BROWSER origin of the app this worker's permalinks point at
   * (`https://app.mcpjam.com`, `https://staging.mcpjam.com`,
   * `http://localhost:6274`).
   *
   * Named separately from `PLATFORM_API_URL` on purpose: one is where the
   * worker sends requests, the other is where a HUMAN opens a link, and the
   * day they diverge (an API subdomain, a proxy) a single variable would send
   * every recipient to a URL no browser renders. `resolveAppOrigin` falls back
   * to the API URL's origin, which is right in every environment configured
   * today, so a deploy that predates this var still mints correct links.
   */
  MCPJAM_APP_ORIGIN?: string;
}
