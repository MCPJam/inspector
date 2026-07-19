/**
 * Translate a resolved per-server `mcpProtocolVersion` pin into the official
 * SDK client's `ClientOptions.versionNegotiation`.
 *
 * This is the config → SDK-policy mapping the official-client cutover (Phase
 * 1B of the MCP 2026-07-28 migration) routes on: once modern connections go
 * through the upstream `Client` instead of the hand-rolled preview, a
 * `2026-07-28` pin becomes a `versionNegotiation` pin rather than a branch to a
 * second client implementation.
 *
 * The manager resolves the pin (host default + per-server override +
 * `isKnownProtocolVersion` validation) before this runs; this module only maps
 * a validated value to negotiation policy. It is intentionally separate from
 * `mcp-protocol-version.ts` (which is hand-mirrored into the backend and must
 * stay free of any `@modelcontextprotocol/client` dependency).
 */

import type { VersionNegotiationOptions } from "@modelcontextprotocol/client";
import {
  isStatelessProtocolVersion,
  type McpProtocolVersion,
} from "./mcp-protocol-version.js";

/**
 * Map a resolved pin to `ClientOptions.versionNegotiation`.
 *
 * - **Modern-era pin** (`2026-07-28`, per `isStatelessProtocolVersion`) →
 *   `{ mode: { pin } }`: negotiate exactly that revision. The connect-time
 *   `server/discover` must offer it; there is no legacy fallback.
 * - **Stateful pin** (`2025-*`) **or no pin** → `undefined`: leave negotiation
 *   at the SDK default (the plain 2025 `initialize` connect). The specific 2025
 *   revision still travels via `ClientOptions.supportedProtocolVersions`,
 *   unchanged — this function does not touch that accept-list.
 *
 * `'auto'` negotiation is deliberately NOT produced here: making `auto` the
 * unconfigured default is the sequenced Phase-5 activation, decided by the
 * caller, not a property of a validated pin.
 */
export function resolveVersionNegotiation(
  mcpProtocolVersion: McpProtocolVersion | undefined,
): VersionNegotiationOptions | undefined {
  if (
    mcpProtocolVersion !== undefined &&
    isStatelessProtocolVersion(mcpProtocolVersion)
  ) {
    return { mode: { pin: mcpProtocolVersion } };
  }
  return undefined;
}
