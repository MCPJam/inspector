/**
 * HostConfig v2 — portable defaults + small pure resolvers.
 *
 * First-party, browser-safe, dependency-free. Exposed via
 * `@mcpjam/sdk/host-config/internal`. The Convex backend imports these
 * alongside the canonicalizer (one source of truth); the inspector client
 * re-exports them from `@/lib/client-config-v2` so its 60+ importers stay
 * untouched.
 *
 * Anything that mints a full `HostConfigInputV2` scaffold (an editor-facing
 * default-filler) belongs in the application layer that knows its own style
 * + model defaults — the SDK deliberately ships no default `style`/`model`
 * (Stage 0b hardening). This module is just the small, opinionated knobs
 * both backend and client can agree on.
 */

import type { McpProtocolVersion } from "./types.js";

/**
 * Default sampling temperature when an editor mints a fresh host config.
 *
 * Mirror of the backend's `DEFAULT_TEMPERATURE_V2` constant (used by
 * `ensureProjectV2Default` to seed new project hosts) and the inspector
 * client's `emptyHostConfigInputV2` default. Lives here so both readers
 * agree on the same number — bumping it later is a one-place edit.
 */
export const DEFAULT_TEMPERATURE_V2 = 0.7;

/**
 * Resolve the effective pinned MCP protocol version for a server
 * connection: per-server override beats host-level default; both
 * undefined yields undefined ("no opinion — SDK chooses at request time").
 *
 * `undefined` is a load-bearing sentinel — do NOT materialize a concrete
 * version when neither layer has an opinion, or canonical hashes churn
 * whenever the SDK default moves and future SDK default upgrades silently
 * no-op against existing rows.
 *
 * Both inputs are optional so callers can read straight off a hydrated
 * host-config row without normalizing first.
 */
export function resolveEffectiveMcpProtocolVersion(
  serverOverride: McpProtocolVersion | undefined,
  hostDefault: McpProtocolVersion | undefined,
): McpProtocolVersion | undefined {
  return serverOverride ?? hostDefault;
}
