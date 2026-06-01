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
 * unknown values before any routing logic runs.
 */
export function isKnownProtocolVersion(v: string): v is McpProtocolVersion {
  return (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(v);
}

/**
 * Routing predicate — returns true for any string NOT on the stateful
 * list. ONLY call after `isKnownProtocolVersion(v)`; otherwise typo
 * strings will route as stateless.
 */
export function isStatelessProtocolVersion(v: string): boolean {
  return v.length > 0 && !STATEFUL_PROTOCOL_VERSIONS.has(v);
}
