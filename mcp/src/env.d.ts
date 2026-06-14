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
}
