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
   * Per-connection supported protocol versions, resolved verbatim from
   * `hostConfig.mcpProfile.initialize.supportedProtocolVersions`. When set,
   * the SDK sends `supportedProtocolVersions[0]` as
   * `initialize.params.protocolVersion` and uses the full array as the
   * accept-list — a server that negotiates any listed version is accepted;
   * a server that negotiates an unlisted version fails fast (desired
   * behavior for reproducible eval pins). Order is semantic; preserve it.
   *
   * An earlier shape passed only `proposedProtocolVersion: string`; that
   * collapsed the accept-list to one entry and quietly broke pins where
   * the user listed multiple versions. Forward the full array.
   */
  supportedProtocolVersions?: string[];
  /**
   * Outbound MCP wire mode resolved from
   * `resolveEffectiveMcpWireMode(serverOverride, hostDefault)`:
   *   - `serverConnectionOverrides[serverId]?.mcpWireModeOverride`
   *   - falling back to `hostConfig.mcpProfile.mcpWireMode`
   *   - falling back to `"legacy"`
   *
   * Absent here means the client didn't compute one — the SDK falls
   * back to the legacy upstream `Client` + initialize handshake, byte-
   * identical to pre-feature behavior. `"stateless-draft-2026-v1"`
   * routes through the experimental DRAFT-2026-v1 stateless preview
   * (no initialize, per-request `_meta` + headers, HTTP POST only).
   * The SDK factory throws `StatelessPreviewRequiresHttpTransport` if
   * applied to stdio / SSE, so the resolver never has to gate on
   * transport here.
   */
  mcpWireMode?: "legacy" | "stateless-draft-2026-v1";
};
