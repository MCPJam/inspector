/**
 * Project-level runtime overrides the inspector client computes via
 * `withProjectConnectionDefaults` and forwards on `/api/mcp/connect` and
 * `/api/mcp/servers/reconnect` requests. The server resolver merges these
 * onto the Convex-stored server config so the resolver path produces the
 * same MCPServerConfig the legacy `{serverConfig}` body would have.
 *
 * One source of truth for the wire shape: client encoder
 * (`state/mcp-api.ts`) and server decoder (`utils/local-server-resolver.ts`)
 * both import from here, so a field added on one side is impossible to
 * forget on the other.
 */
export type ConnectionDefaults = {
  /**
   * Header overlay merged on top of Convex-stored server headers. OAuth's
   * `Authorization` header (when present) always wins on the resolver side.
   */
  headers?: Record<string, string>;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** MCP client capabilities forwarded to the SDK transport. */
  clientCapabilities?: Record<string, unknown>;
  /**
   * Per-connection MCP `initialize.params.clientInfo` override, resolved
   * client-side from `hostConfig.mcpProfile.initialize.clientInfo`. Undefined
   * means "use SDK defaults" — preserves historical wire behavior for users
   * who haven't opted into the mcpProfile feature. Extra fields (`title`
   * and future spec additions) survive verbatim through the SDK without an
   * SDK bump.
   */
  clientInfo?: { name?: string; version?: string } & Record<string, unknown>;
  /**
   * Per-connection proposed protocolVersion, resolved from the first entry
   * of `hostConfig.mcpProfile.initialize.supportedProtocolVersions`. When
   * set, the SDK sends this in `initialize.params.protocolVersion` AND uses
   * it as the sole accept-list entry — a server that can't speak it fails
   * fast (desired behavior for reproducible eval pins).
   */
  proposedProtocolVersion?: string;
};
