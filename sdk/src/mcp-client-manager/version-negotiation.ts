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
 * - **Stateful pin** (`2025-*`) → `undefined`: run the exact legacy
 *   `initialize` handshake. The specific revision still travels via
 *   `ClientOptions.supportedProtocolVersions`; this function does not touch
 *   that accept-list.
 * - **No pin** → `{ mode: "auto" }`: probe with `server/discover`, selecting
 *   the modern era only on definitive modern evidence. Fallback is
 *   deliberately broad — per the official client's documented contract,
 *   definitive legacy signals AND anything unrecognized (opaque `400`, `404`,
 *   `405`, `406`, `5xx`, `-32601`) fall back to the plain `initialize`
 *   handshake on the same connection, byte-equivalent to a 2025 client.
 *   Exactly two outcomes fail the connect instead of falling back: a network
 *   outage, and a probe timeout on HTTP (silence from a deployed server
 *   indicates an outage, not a legacy server; on stdio a timeout IS a legacy
 *   signal and falls back).
 *
 * Automatic negotiation is ALWAYS ON and transport-agnostic: the manager
 * calls this helper for both HTTP and stdio servers. An unconfigured
 * connection resolves to `{ mode: "auto" }` on either transport (on stdio the
 * `server/discover` probe runs on a sibling process — the server binary is
 * spawned a second time). Explicit pins are honored on HTTP connections only;
 * stdio always negotiates in `auto` mode, because `mcpProtocolVersion` is
 * HTTP-only and the manager never forwards a pin to a stdio transport.
 */
export function resolveVersionNegotiation(
  mcpProtocolVersion: McpProtocolVersion | undefined
): VersionNegotiationOptions | undefined {
  if (mcpProtocolVersion === undefined) {
    return { mode: "auto" };
  }
  if (isStatelessProtocolVersion(mcpProtocolVersion)) {
    return { mode: { pin: mcpProtocolVersion } };
  }
  return undefined;
}
