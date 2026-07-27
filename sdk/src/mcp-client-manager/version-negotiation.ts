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
 * The manager calls this helper only for HTTP servers. Stdio remains on its
 * historical legacy default until MCPJam explicitly exposes modern stdio
 * negotiation.
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

/**
 * The transport an outbound connection uses. Auto-negotiation on stdio spawns
 * the server binary a SECOND time for the probe (a sibling process); HTTP
 * probes with an extra `server/discover` request on the same origin. The
 * distinction is load-bearing for activation policy — see
 * {@link resolveActivatedVersionNegotiation}.
 */
export type ConnectionTransportKind = "http" | "stdio";

/**
 * Phase 5 exit-gate activation policy for AUTOMATIC era negotiation of
 * UNCONFIGURED connections (no explicit `mcpProtocolVersion` pin).
 *
 * This is the product-level switch the migration plan (§13 "Auto-default
 * activation") calls for: flipping unconfigured connections from the exact
 * legacy `initialize` handshake to `versionNegotiation: { mode: "auto" }`
 * changes DEFAULT connection behavior for every user, so it is gated rather
 * than flipped in place. It is deliberately DEFAULT-OFF; the on-by-default
 * flip is a separate reviewed step.
 *
 * Scope of the switch: it governs the UNCONFIGURED case only. Explicit pins
 * are always honored regardless of activation — an explicit legacy pin stays
 * byte-stable, and an explicit modern pin still negotiates the modern era
 * (failing rather than silently falling back to legacy).
 */
export interface VersionNegotiationActivation {
  /**
   * Master switch. `false` (the default) ⇒ an unconfigured connection uses
   * the SDK legacy default and stdio never auto-negotiates — byte-identical
   * to the pre-activation behavior. `true` ⇒ unconfigured connections
   * resolve to `auto` on BOTH transports.
   */
  enabled: boolean;
}

/**
 * The default activation policy: OFF. Sharing one frozen value keeps every
 * unconfigured construction site (SDK tests, CLI, hosted) byte-identical to
 * the legacy default until a surface explicitly opts in.
 */
export const DEFAULT_VERSION_NEGOTIATION_ACTIVATION: VersionNegotiationActivation =
  Object.freeze({ enabled: false });

/**
 * Resolve `ClientOptions.versionNegotiation` for a connection, applying the
 * Phase 5 activation policy on top of {@link resolveVersionNegotiation}.
 *
 * - **Activation OFF** (default) — byte-identical to the pre-activation
 *   default:
 *   - `stdio` → `undefined` (the historical `initialize` path; stdio never
 *     auto-negotiates);
 *   - `http` with an explicit pin → the pin is honored exactly
 *     (`resolveVersionNegotiation`): a modern pin negotiates modern (no
 *     legacy fallback), a legacy pin stays byte-stable;
 *   - `http` with NO pin → `undefined` (the exact legacy handshake, **not**
 *     `auto`).
 * - **Activation ON** — unconfigured connections auto-negotiate on BOTH
 *   transports; explicit pins are still honored exactly. This is simply
 *   {@link resolveVersionNegotiation} applied uniformly to http and stdio.
 *
 * The activation flag NEVER changes an explicit-pin outcome; it only decides
 * whether the UNCONFIGURED case (and stdio at all) reaches `auto`.
 */
export function resolveActivatedVersionNegotiation(
  mcpProtocolVersion: McpProtocolVersion | undefined,
  transport: ConnectionTransportKind,
  activation: VersionNegotiationActivation = DEFAULT_VERSION_NEGOTIATION_ACTIVATION
): VersionNegotiationOptions | undefined {
  if (!activation.enabled) {
    // Deactivated: stdio stays on the historical initialize path, and an
    // unconfigured HTTP connection uses the exact legacy handshake rather
    // than probing. Explicit HTTP pins still route through the mapping so a
    // modern pin fails-not-falls-back and a legacy pin is byte-stable.
    if (transport === "stdio") {
      return undefined;
    }
    if (mcpProtocolVersion === undefined) {
      return undefined;
    }
    return resolveVersionNegotiation(mcpProtocolVersion);
  }
  // Activated: unconfigured → auto on both transports; explicit pins honored.
  return resolveVersionNegotiation(mcpProtocolVersion);
}
