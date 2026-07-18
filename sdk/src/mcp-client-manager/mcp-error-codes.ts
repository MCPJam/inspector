/**
 * Centralized MCP error codes — the single source of truth for the numeric
 * JSON-RPC codes MCPJam reads off the wire and stamps onto its own errors.
 *
 * Why this module exists (and why the values look duplicated):
 *
 * The 2026-07-28 draft renumbered its new protocol codes late in review
 * (HeaderMismatch `-32001`→`-32020`, MissingRequiredClientCapability
 * `-32003`→`-32021`, UnsupportedProtocolVersion `-32004`→`-32022`) and folded
 * resource-not-found into InvalidParams (`-32002`→`-32602`). The installed SDK
 * (`@modelcontextprotocol/client` v2 alpha.2) predates that renumber: its
 * `ProtocolErrorCode` still carries the pre-renumber values and omits
 * HeaderMismatch / MissingRequiredClientCapability entirely. So the final
 * values live here, MCPJam-side, until the SDK bump.
 *
 * PHASE 1 RECONCILIATION: once the SDK is on beta.4 (which ships the renumbered
 * `ProtocolErrorCode`), `MCP_ERROR_CODES` should become a thin re-export /
 * alias of the SDK enum and `PRE_RENUMBER_DRAFT_ERROR_CODES` should be deleted
 * along with the preview client that still emits those codes. This module is
 * the one place that swap happens.
 *
 * Provenance of each group is noted inline; keep them grouped so the Phase 1
 * reconciliation is mechanical.
 */

/**
 * Canonical, final wire codes. Stable JSON-RPC codes, the post-renumber
 * 2026-07-28 protocol codes, and the SDK-local codes in the
 * implementation-defined `-32000..-32019` range (grandfathered by the spec's
 * error-code allocation policy).
 */
export const MCP_ERROR_CODES = {
  // --- JSON-RPC 2.0 standard (stable across every MCP revision) ---
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,

  // --- 2026-07-28 modern protocol codes (post-renumber, final wire values) ---
  HeaderMismatch: -32020,
  MissingRequiredClientCapability: -32021,
  UnsupportedProtocolVersion: -32022,

  // 2026-07-28 folds resource-not-found into InvalidParams (was -32002).
  // Numerically identical to InvalidParams — intentional, per the changelog.
  ResourceNotFound: -32602,

  // --- SDK-local / transport, implementation-defined -32000..-32019 ---
  ConnectionClosed: -32000,
  RequestTimeout: -32001,

  // --- MCP extension ---
  UrlElicitationRequired: -32042,
} as const;

/**
 * Legacy (≤ 2025-11-25) resource-not-found code. Real pre-2026 servers emit
 * `-32002`; the modern era uses {@link MCP_ERROR_CODES.ResourceNotFound}
 * (`-32602`). Both remain valid on their respective eras for as long as legacy
 * support is in scope.
 */
export const LEGACY_RESOURCE_NOT_FOUND = -32002;

/**
 * Pre-renumber 2026 DRAFT codes. These are NOT final wire codes. They are
 * retained only so MCPJam still describes errors emitted by its own
 * not-yet-migrated preview client and test fixtures during the Phase 0→1
 * window. DELETE in Phase 1 once the preview client is gone and every fixture
 * emits {@link MCP_ERROR_CODES}.
 */
export const PRE_RENUMBER_DRAFT_ERROR_CODES = {
  HeaderMismatch: -32001,
  MissingRequiredClientCapability: -32003,
  UnsupportedProtocolVersion: -32004,
} as const;
