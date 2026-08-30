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
   * (today: `"2026-07-28"`), the SDK routes through
   * `StatelessMcpHttpPreviewClient` — HTTP POST only; factory throws
   * `StatelessRequiresHttpTransport` for stdio / SSE, so the resolver
   * never has to gate on transport here.
   */
  mcpProtocolVersion?: import("@mcpjam/sdk/browser").McpProtocolVersion;
  /**
   * SEP-2243 `Mcp-Param-*` mirroring, reduced from
   * `hostConfig.mcpProfile.toolParamHeaderMirroring` to the boolean the SDK
   * config takes. Only ever `false` — `"mirror"` (and an absent field) mean
   * the spec-conforming default, which is what the SDK does with no field at
   * all, so sending `true` would put a value on every connection that never
   * carried one.
   *
   * `false` deliberately simulates a client that never mirrors, so a server
   * can be exercised against the non-conforming clients that exist in the
   * wild. HTTP-only: mirroring is a Streamable HTTP concern.
   */
  mirrorToolParamHeaders?: boolean;
  /**
   * Client-conformance knobs resolved from the active host's
   * `mcpProfile.paginationTraversal` / `mcpProfile.mrtrSupport`. Like the
   * mirroring field above, only the NON-default value is ever sent — the SDK
   * treats an absent field as the full behavior, so sending the default
   * would put a field on every connection that never carried one.
   *
   * Unlike mirroring, neither is HTTP-only: pagination truncation is enforced
   * on JSON-RPC frames and the MRTR knob works through capability
   * advertisement, so both apply on stdio too.
   */
  firstPageOnly?: true;
  supportsMrtr?: false;
  /**
   * Resolved from `mcpProfile.toolListChanged`. `suppressListenChannel` stops
   * the client opening the server→client notification stream at all;
   * `dropToolListChanged` lets it open but ignores
   * `notifications/tools/list_changed`. Same only-the-non-default rule.
   */
  suppressListenChannel?: true;
  dropToolListChanged?: true;
  /**
   * The host's enterprise-managed authorization policy, resolved client-side
   * via `readXaaEnterprisePolicy(hostConfig.mcpProfile)`. Present only when
   * the policy is validly ON — the client surfaces an `invalid` policy as a
   * configuration error before connecting, and the resolver re-validates.
   * Under the policy every HTTP `auto` server resolves to XAA; explicit
   * per-server auth methods override. Local connections are the user's own
   * session, so a body-supplied value here is self-tampering only (hosted
   * surfaces read the policy from the backend-projected host config
   * instead).
   */
  xaaPolicy?: import("@mcpjam/sdk/browser").XaaEnterprisePolicy;
};
