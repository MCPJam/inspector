/**
 * MCP protocol version constants and predicates.
 *
 * `McpProtocolVersion` is the user-facing pin a server connection can be
 * locked to. Values are wire literals — they go directly into
 * `_meta.io.modelcontextprotocol/protocolVersion` and into the
 * `MCP-Protocol-Version` HTTP header.
 *
 * **Validate-then-route discipline:**
 *   - Trust boundaries (Convex validator, REST input parser, UI form
 *     submit) MUST gate on `isKnownProtocolVersion(v)` first. Typo strings
 *     like `"DRAFT-2027-zzz"` (and the retired pre-RC placeholder
 *     `"DRAFT-2026-v1"`) fail here.
 *   - Inside trusted code (the factory, the preview client) use
 *     `isStatelessProtocolVersion(v)` for routing. It returns true for
 *     anything not on the closed `STATEFUL_PROTOCOL_VERSIONS` set —
 *     correct only after membership has been validated upstream.
 *
 * A hand-mirrored copy lives in the backend at
 * `mcpjam-backend/convex/lib/mcpProtocolVersion.ts`. Keep them in sync;
 * adding a new version requires updating both, plus the Convex schema
 * validators in `mcpjam-backend/convex/schema.ts`.
 */

/**
 * Every MCP protocol version a server connection can be pinned to. Order
 * is purely historical; UI ordering lives in the inspector's dropdown.
 */
export const MCP_PROTOCOL_VERSIONS = [
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
  "2026-07-28",
] as const;
export type McpProtocolVersion = (typeof MCP_PROTOCOL_VERSIONS)[number];

/**
 * Auto-detect sentinel. NOT a wire literal and deliberately NOT a member
 * of `MCP_PROTOCOL_VERSIONS` — adding it there would let the open
 * `isStatelessProtocolVersion` predicate route `"auto"` to the stateless
 * client and emit `MCP-Protocol-Version: auto` on the wire. Instead,
 * `"auto"` is resolved by `MCPClientManager` at connect time: it probes
 * the server with `server/discover` (2026-07-28) and falls back to the
 * legacy `initialize` handshake when the server doesn't speak the
 * stateless RC. Config pins (`McpProtocolVersionPin`) may carry it;
 * anything that builds wire requests must have resolved it first.
 */
export const MCP_PROTOCOL_VERSION_AUTO = "auto" as const;
export type McpProtocolVersionAuto = typeof MCP_PROTOCOL_VERSION_AUTO;

/**
 * What a host config / per-server override may pin a connection to: a
 * concrete wire version OR the `"auto"` detect-at-connect sentinel. Use
 * this type for stored configuration; use `McpProtocolVersion` for
 * anything that ends up in headers or `_meta`.
 */
export type McpProtocolVersionPin = McpProtocolVersion | McpProtocolVersionAuto;

/**
 * Closed list of stateful (pre-2026) protocol versions. Hardcoded by
 * design (mirrors upstream `packages/core/src/shared/stateless.ts`):
 * deriving from `MCP_PROTOCOL_VERSIONS` would silently misclassify any
 * newly added stateful version. New stateful versions are not expected;
 * if one ever ships, add it here explicitly.
 *
 * Broader than `MCP_PROTOCOL_VERSIONS` — covers older wire versions
 * (`2024-11-05`, `2024-10-07`) so legacy stored data still classifies
 * correctly.
 */
const STATEFUL_PROTOCOL_VERSIONS: ReadonlySet<string> = new Set([
  "2024-10-07",
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
]);

/**
 * Membership predicate. Use this at trust boundaries to reject typo /
 * unknown values before any routing logic runs. Rejects `"auto"` — use
 * `isKnownProtocolVersionPin` at boundaries that accept the detect
 * sentinel (host configs, per-server overrides).
 */
export function isKnownProtocolVersion(v: string): v is McpProtocolVersion {
  return (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(v);
}

/** True only for the `"auto"` detect-at-connect sentinel. */
export function isAutoProtocolVersion(v: string): v is McpProtocolVersionAuto {
  return v === MCP_PROTOCOL_VERSION_AUTO;
}

/**
 * Membership predicate for stored pins: a known wire version OR `"auto"`.
 * Use at trust boundaries that validate configuration (Convex validator,
 * REST input parser, UI form submit). Wire-building code must still
 * resolve `"auto"` before emitting anything.
 */
export function isKnownProtocolVersionPin(
  v: string
): v is McpProtocolVersionPin {
  return isAutoProtocolVersion(v) || isKnownProtocolVersion(v);
}

/**
 * Routing predicate — returns true for any string NOT on the stateful
 * list. ONLY call after `isKnownProtocolVersion(v)`; otherwise typo
 * strings will route as stateless.
 */
export function isStatelessProtocolVersion(v: string): boolean {
  return v.length > 0 && !STATEFUL_PROTOCOL_VERSIONS.has(v);
}
