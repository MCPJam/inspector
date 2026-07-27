/**
 * Phase 5 exit-gate flag: activation of AUTOMATIC MCP era negotiation for
 * UNCONFIGURED server connections (no explicit `mcpProtocolVersion` pin).
 *
 * When ON, an unconfigured connection resolves to SDK `versionNegotiation:
 * { mode: "auto" }` on both HTTP and stdio — the client probes with
 * `server/discover` and selects the modern (`2026-07-28`) era on definitive
 * modern evidence, falling back to the legacy `initialize` handshake
 * otherwise. When OFF, an unconfigured connection uses the exact legacy
 * default and stdio never auto-negotiates — byte-identical to the
 * pre-activation behavior. Explicit per-server pins are always honored
 * regardless of this flag.
 *
 * ## Why a constant, not an env var
 *
 * This repo does not gate NEW product behavior on ad-hoc environment
 * variables (a fail-open `process.env.X === "true"` knob is exactly what we
 * avoid). The flag is a single compile-time constant — flipping the default
 * is a one-line, reviewed code change, not an ops toggle. It is the sibling of
 * `HOSTED_MODE` / `NON_PROD_LOCKDOWN` in `server/config.ts`, kept in its own
 * module because the activation policy is consumed by every manager
 * construction site (local, hosted, evals) and carries dedicated telemetry.
 *
 * ## DEFAULT: OFF
 *
 * Auto-negotiation changes DEFAULT connection behavior for every user, so it
 * ships OFF. Turning it ON by default is a SEPARATE, deliberately reviewed
 * step — flip {@link AUTO_NEGOTIATION_ACTIVATION_ENABLED} to `true`.
 */

import type { VersionNegotiationActivation } from "@mcpjam/sdk";

/**
 * The master switch. DEFAULT OFF. Flip to `true` only as the reviewed
 * on-by-default activation step (see module doc). Do not read an env var here.
 */
export const AUTO_NEGOTIATION_ACTIVATION_ENABLED = false;

/**
 * The activation policy object to hand to `new MCPClientManager(_, {
 * versionNegotiationActivation })`. Threaded at every server-side manager
 * construction site so activation is a single, consistent decision.
 */
export function versionNegotiationActivation(): VersionNegotiationActivation {
  return { enabled: AUTO_NEGOTIATION_ACTIVATION_ENABLED };
}
