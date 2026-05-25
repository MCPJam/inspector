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
   * Pinned MCP protocol version resolved from
   * `resolveEffectiveMcpProtocolVersion(serverOverride, hostDefault)`:
   *   - `serverConnectionOverrides[serverId]?.mcpProtocolVersionOverride`
   *   - falling back to `hostConfig.mcpProfile.mcpProtocolVersion`
   *   - falling back to `undefined` (SDK default)
   *
   * Absent here means the client didn't compute a pin — the SDK
   * negotiates at request time. When set to a stateful version (per
   * `isStatelessProtocolVersion`), the legacy upstream `Client` +
   * initialize handshake runs with the pin in
   * `supportedProtocolVersions`. When set to a stateless version
   * (today: `"DRAFT-2026-v1"`), the SDK routes through
   * `StatelessMcpHttpPreviewClient` — HTTP POST only; factory throws
   * `StatelessRequiresHttpTransport` for stdio / SSE, so the resolver
   * never has to gate on transport here.
   */
  mcpProtocolVersion?: import("@mcpjam/sdk/browser").McpProtocolVersion;
};
