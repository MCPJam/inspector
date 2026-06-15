/**
 * Resolves the platform MCP worker URL the Home/MCPJam agent connects to,
 * keyed on the deployment environment so the URL follows the environment and
 * cannot silently drift (e.g. staging falling back to the prod worker).
 *
 * Kept as a tiny standalone module — NOT an export on the chat/MCP route — so
 * it can be unit-tested without pulling in the route's heavy dependencies.
 */
import { resolveEnvironment, type Environment } from "./log-events.js";
import { logger } from "./logger.js";

// Exhaustive over `Environment`: TypeScript guarantees a value for every case,
// so an unmapped environment is a compile error rather than a silent runtime
// fall-through to prod. `preview` (PR previews) shares the staging worker.
const PLATFORM_MCP_URL_BY_ENV: Record<Environment, string> = {
  local: "http://localhost:8787/mcp",
  dev: "http://localhost:8787/mcp",
  test: "http://localhost:8787/mcp",
  preview: "https://mcp-staging.mcpjam.com/mcp",
  staging: "https://mcp-staging.mcpjam.com/mcp",
  prod: "https://mcp.mcpjam.com/mcp",
};

/**
 * The platform MCP worker URL for the current environment. Set
 * `MCPJAM_PLATFORM_MCP_URL` to override (one-off worker / preview testing);
 * otherwise the URL is derived from `ENVIRONMENT` via `resolveEnvironment()`.
 *
 * NOTE: staging resolves to the staging worker ONLY when the deployment sets
 * `ENVIRONMENT=staging`; with it unset + `NODE_ENV=production`,
 * `resolveEnvironment()` returns `"prod"`. The Railway staging service must
 * therefore set `ENVIRONMENT=staging`.
 */
export function resolvePlatformMcpUrl(): string {
  const override = process.env.MCPJAM_PLATFORM_MCP_URL?.trim();
  if (override) {
    // Log only the origin — the value is operator-supplied and could carry a
    // query token; the full URL doesn't belong in server logs.
    let origin: string;
    try {
      origin = new URL(override).origin;
    } catch {
      origin = "(unparseable)";
    }
    logger.info(`[platform-mcp] using MCPJAM_PLATFORM_MCP_URL override (${origin})`);
    return override;
  }
  return PLATFORM_MCP_URL_BY_ENV[resolveEnvironment()];
}
