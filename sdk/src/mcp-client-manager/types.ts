/**
 * TypeScript types and interfaces for MCPClientManager
 */

import type {
  CacheMode,
  CacheScope,
  CallToolResult,
  Client,
  ClientOptions,
  ElicitRequest,
  ElicitResult,
  ListTasksResult as BaseListTasksResult,
  RequestOptions,
  SSEClientTransportOptions,
  StreamableHTTPClientTransportOptions,
  Task as BaseTask,
  Tool as BaseTool,
  Transport,
} from "@modelcontextprotocol/client";
// beta.4 moved the stdio transport params to the `/stdio` subpath.
import type { StdioServerParameters } from "@modelcontextprotocol/client/stdio";
import type { RetryPolicy } from "../retry.js";
import type { RefreshTokenOAuthProvider } from "./refresh-token-auth-provider.js";
import type { TraceContextProvider } from "./trace-context.js";
import type { HttpExchangeLogger } from "./http-exchange-log.js";
import type { ToolSet } from "ai";

// Re-export ElicitResult for convenience
export type { ElicitResult };

/**
 * The per-call cache disposition for the SEP-2549 cacheable verbs
 * (`listTools` / `listPrompts` / `listResources` / `listResourceTemplates` /
 * `readResource`). Re-exported verbatim from the upstream client so callers
 * can `import { CacheMode } from "@mcpjam/sdk"`.
 *
 *   - `"use"` (upstream default) serves a still-fresh cached entry — a hit
 *     costs ZERO wire exchange. A result is "fresh" only when the server sent
 *     `ttlMs > 0` (SEP-2549) AND that ttl has not elapsed; `defaultCacheTtlMs`
 *     stays `0`, so a result WITHOUT a server `ttlMs` is stored but never
 *     served (every call refetches).
 *   - `"refresh"` always fetches and re-stores (the "Refresh" affordance).
 *   - `"bypass"` fetches without consulting OR writing the cache — the raw /
 *     conformance evidence disposition.
 *
 * NOTE: only the 2026-07-28 wire codec emits `ttlMs`/`cacheScope`; a 2025-era
 * connection never carries them, so an invisible cache serve is a modern-era
 * phenomenon. The cache engine itself is era-blind (it reads `ttlMs` off the
 * decoded body), but the body only has `ttlMs` when the modern codec put it
 * there.
 */
export type { CacheMode, CacheScope };

/**
 * A single local cache-serve event, reported by `ObservableResponseCache` to
 * {@link CacheEventLogger} when a cacheable verb is answered from a still-fresh
 * cached entry (a `get` whose `expiresAt > now`).
 *
 * This is a LOCAL event with no wire counterpart — it MUST NOT be conflated
 * with {@link RpcLogger} traffic. A cache hit is precisely the case where NO
 * JSON-RPC request left the process, so injecting it into the rpc/wire log
 * would make an invisible serve masquerade as a real request.
 */
export interface CacheHitEvent {
  /** The server whose connection served the entry. */
  serverId: string;
  /** The cacheable method (`"tools/list"`, `"resources/read"`, …). */
  method: string;
  /** Canonical params key (`""` for the list verbs, the `uri` for reads). */
  params?: string;
  /**
   * Age of the served entry in milliseconds (now − store time). Best-effort;
   * see `ObservableResponseCache` for the heuristic's known imprecision.
   */
  ageMs: number;
  /** Server-reported cache scope (`"public"` / `"private"`), if present. */
  scope?: CacheScope;
}

/**
 * Callback invoked for each fresh cache-serve. Distinct channel from
 * {@link RpcLogger}: cache hits never appear on the wire, so they surface
 * here — never as rpc log entries. Absence of an emission is NOT proof a call
 * hit the wire; see `ObservableResponseCache`.
 */
export type CacheEventLogger = (event: CacheHitEvent) => void;

/**
 * The negotiation mode a connection actually requested of the underlying
 * client. Auto-negotiation is unconditional, so an unconfigured connection is
 * always probed:
 *  - `"auto"` — unconfigured connection (always probed);
 *  - `"modern-pin"` — an explicit modern (`2026-07-28`) pin;
 *  - `"legacy"` — the exact legacy `initialize` handshake, from an explicit
 *    legacy pin.
 */
export type ConfiguredNegotiationMode = "auto" | "modern-pin" | "legacy";

/**
 * One connection-attempt outcome, emitted by the manager for Phase 5
 * auto-negotiation-activation telemetry. This is a LOCAL provenance channel
 * (like {@link CacheEventLogger}) — the manager NEVER emits analytics itself;
 * each surface wires this to its own PostHog/Axiom pipeline and stamps the
 * `surface` dimension there.
 *
 * The fields are exactly the activation-checklist telemetry requirement:
 * configured mode + negotiated era + transport + outcome + failure class.
 * (`surface` is added by the consumer.) It carries NO request payloads.
 */
export interface NegotiationOutcomeEvent {
  /** The server whose connection was attempted. */
  serverId: string;
  /** Transport the attempt used. */
  transport: "http" | "stdio";
  /** The negotiation mode the client was actually asked to use. */
  configuredMode: ConfiguredNegotiationMode;
  /** Whether the connection established or failed. */
  outcome: "connected" | "failed";
  /** Negotiated era once connected (`undefined` on failure / unknown). */
  negotiatedEra?: "legacy" | "modern";
  /** Negotiated wire protocol version once connected (`undefined` on failure). */
  negotiatedProtocolVersion?: string;
  /**
   * Coarse, non-PII failure class on failure — the era-negotiation-unwrapped
   * error's `name` (or `code`), e.g. `"UnauthorizedError"`,
   * `"EraNegotiationFailed"`, `"TypeError"`. `undefined` on success.
   */
  failureClass?: string;
}

/**
 * Callback invoked once per connection attempt with its negotiation outcome.
 * Distinct channel from {@link RpcLogger}/{@link CacheEventLogger}; never
 * throws into the connect path (the manager guards it). Unset ⇒ no telemetry
 * and byte-identical connect behavior.
 */
export type NegotiationOutcomeLogger = (event: NegotiationOutcomeEvent) => void;

/**
 * MCPJam response-cache POLICY (SEP-2549). This is the single source of truth
 * for how the debugger disposes of the client's response cache; the code above
 * and the raw-evidence surfaces (`server-snapshot`, `server-doctor`,
 * `mcp-conformance`) implement it.
 *
 * 1. **Default UI reads use `"use"`.** A default read MAY be served from cache
 *    — but ONLY when (a) the server sent `ttlMs > 0` (so the entry is fresh)
 *    AND (b) MCPJam surfaces the serve's provenance and age to the operator
 *    (via {@link CacheEventLogger}). A serve the operator cannot see is
 *    indistinguishable from a fabricated wire response and is forbidden.
 * 2. **`defaultCacheTtlMs` stays `0`.** A result WITHOUT a server `ttlMs` is
 *    stored (so the client's `tools/list`-derived index keeps working) but is
 *    NEVER served. Invisible serving therefore happens EXACTLY when a server
 *    opts in with `ttlMs > 0`.
 * 3. **"Refresh" ⇒ `cacheMode: "refresh"`.** The refresh affordance always
 *    fetches and re-stores.
 * 4. **Raw / conformance ⇒ `cacheMode: "bypass"`.** Evidence surfaces neither
 *    consult nor write the cache.
 *
 * ### Explicitly DEFERRED: persisted-discovery (`prior`) reconnect
 *
 * The upstream client supports a zero-round-trip reconnect by adopting a prior
 * {@link import("@modelcontextprotocol/client").DiscoverResult} on `connect`
 * (`ConnectOptions.prior`). MCPJam does NOT implement this here — it is
 * deferred pending owner sign-off on how to display the provenance of an
 * adopted-without-a-handshake connection. When implemented, the persisted
 * `DiscoverResult` MUST be keyed by the full authorization/negotiation context
 * so a cached discovery is never reused across a different principal or a
 * different negotiated shape. The intended key spec is:
 *
 *   - server ORIGIN (scheme + host + port of the MCP endpoint),
 *   - AUTH / TENANT context (the same identity that scopes the response cache
 *     partition — e.g. the auth subject / `cachePartition`), and
 *   - NEGOTIATION INPUTS (proposed protocol-version accept-list + advertised
 *     client capabilities) that produced the `DiscoverResult`.
 *
 * Do NOT reuse a `prior` across any change in those inputs.
 */

/**
 * Client capability options extracted from MCP SDK ClientOptions
 */
export type ClientCapabilityOptions = NonNullable<
  ClientOptions["capabilities"]
>;

// ============================================================================
// Server Configuration Types
// ============================================================================

/**
 * Base configuration shared by all server types
 */
export type BaseServerConfig = {
  /** Legacy merge-style client capabilities to advertise to this server */
  capabilities?: ClientCapabilityOptions;
  /**
   * Exact client capabilities to advertise to this server.
   * When provided, this bypasses manager defaults and legacy capability merging.
   */
  clientCapabilities?: ClientCapabilityOptions;
  /**
   * Era-conditional capability overlays, applied once the connection's era is
   * actually KNOWN — the post-negotiation re-resolution seam.
   *
   * Capabilities are resolved at connect time, before negotiation has run, so
   * the base set must be honest under the most conservative era the connection
   * could land on (a capability the legacy bridge cannot fulfil must not ride
   * an `initialize` that a 2025 server holds for the whole session). That
   * forces auto-negotiated connections to under-advertise on the modern era —
   * e.g. url-mode elicitation, perfectly fulfillable on 2026-07-28, stayed
   * undeclared because the connect-time resolver couldn't rule out a legacy
   * landing.
   *
   * `modern` is a merge-style overlay (same semantics as `capabilities`)
   * merged over the connect-time set exactly ONCE, immediately after era
   * classification, when the connection lands on a 2026-era revision:
   *
   * - The 2026 wire re-sends capabilities on EVERY request (the `_meta`
   *   envelope reads the live set), so the widened declaration simply flows
   *   outward from the next request on; the only frames that carried the
   *   narrow set are the negotiation probe itself.
   * - After that single application the declaration is STABLE for the
   *   connection's lifetime — MRTR rounds of one logical operation always
   *   see one consistent set.
   * - A connection that lands on a 2025 era never applies the overlay, and
   *   its `initialize` already carried the conservative base: fail-closed.
   *
   * The overlay's `elicitation` key is subject to the same advertise=enforce
   * gate as the runtime-added one: it is dropped unless an elicitation
   * handler or MRTR input collector is actually registered.
   *
   * Ignored entirely when `clientCapabilities` (an EXACT set) is configured —
   * widening a pinned declaration would defeat the point of pinning one.
   */
  eraCapabilities?: {
    /** Overlay merged when the connection classifies as 2026-era (stateless). */
    modern?: ClientCapabilityOptions;
  };
  /** Request timeout in milliseconds */
  timeout?: number;
  /** Client version to report */
  version?: string;
  /**
   * Per-server override of `clientInfo` sent in MCP `initialize`. When set,
   * takes precedence over the manager's `defaultClientName` /
   * `defaultClientVersion` and the per-server `version`. Extra fields
   * (e.g. `title`) are passed through verbatim so future spec additions
   * land here without an SDK bump.
   *
   * Wired into the inspector via `hostConfig.mcpProfile.initialize.clientInfo`.
   * Leaving this undefined means "use the manager defaults" (which is what
   * historical callers expect).
   */
  clientInfo?: { name?: string; version?: string } & Record<string, unknown>;
  /**
   * Supported protocol versions accept-list passed into the upstream Client
   * as `ClientOptions.supportedProtocolVersions`. The Client sends
   * `supportedProtocolVersions[0]` as `initialize.params.protocolVersion`
   * and accepts any of the listed versions in the server's response.
   *
   * Wired into the inspector verbatim from
   * `hostConfig.mcpProfile.initialize.supportedProtocolVersions`. Order is
   * semantic — preserve it. A pin like `["2025-11-25", "2025-06-18"]`
   * proposes the newer version but still accepts the older one if the
   * server negotiates it; the prior shape (`proposedProtocolVersion:
   * string`) collapsed this to a singleton and silently broke that case.
   */
  supportedProtocolVersions?: string[];
  /**
   * Whether `tools/call` mirrors the tool's `x-mcp-header`-annotated
   * arguments into `Mcp-Param-{Name}` request headers (SEP-2243, `2026-07-28`
   * Streamable HTTP: "clients **MUST** mirror the designated parameter values
   * into HTTP headers").
   *
   * `undefined` (the default) and `true` both mirror. `false` deliberately
   * simulates a NON-CONFORMING client that never sends them, so a server can
   * be exercised against one — a conforming server should answer
   * `-32020 HeaderMismatch`, and MCPJam surfaces that failure unmasked rather
   * than recovering from it.
   *
   * Wired into the inspector via
   * `hostConfig.mcpProfile.toolParamHeaderMirroring` (`"mirror"` | `"omit"`).
   * Streamable-HTTP + modern-era only, like the mirroring itself: stdio and
   * 2025-era connections never mirror, so the flag is inert there.
   */
  mirrorToolParamHeaders?: boolean;
  /**
   * Whether the client walks a paginated list to exhaustion, or reads page
   * one and stops.
   *
   * `undefined` (the default) and `false` both walk every page. `true`
   * deliberately simulates the real hosts that read only the first page, so a
   * server author can see what their server looks like through one — tools
   * beyond page one are invisible, and (on `2026-07-28`) a `tools/call` on
   * such a tool carries no mirrored `Mcp-Param-*`, because the SEP-2243
   * mirroring source is the page-one-only aggregate the client cached.
   *
   * Wired into the inspector via `hostConfig.mcpProfile.paginationTraversal`
   * (`"full"` | `"firstPageOnly"`). Applies on every era and every transport —
   * pagination predates 2026 and is not HTTP-specific. Only the cursor-less
   * aggregation is truncated; an explicit-cursor request (the debugger's own
   * manual paging) is left alone.
   */
  firstPageOnly?: boolean;
  /**
   * Whether the client opens the server→client notification channel at all.
   *
   * `undefined` (the default) and `false` both open it. `true` simulates a
   * client that never does — ChatGPT measures this way — so a server author
   * can see that its `notifications/*` never reach that host, no matter what
   * the server declares.
   *
   * On Streamable HTTP this refuses the standalone GET SSE stream the
   * upstream client opens after `notifications/initialized`. On the legacy
   * HTTP+SSE transport the GET stream IS the connection, so this cannot
   * apply — a real client on that transport cannot not-listen either.
   *
   * Wired via `hostConfig.mcpProfile.toolListChanged.listens === false`.
   */
  suppressListenChannel?: boolean;
  /**
   * Whether the client acts on `notifications/tools/list_changed`.
   *
   * `undefined` (the default) and `false` both act on it. `true` simulates a
   * client that ignores it: the notification is dropped before the client
   * sees it, so its `tools/list` cache is never evicted and the stale list
   * stays in use — exactly what a server author sees from such a host.
   *
   * Wired via `hostConfig.mcpProfile.toolListChanged.refetches === false`.
   */
  dropToolListChanged?: boolean;
  /**
   * Whether the client drives MRTR (`resultType: "input_required"`) retry
   * rounds at all.
   *
   * `undefined` (the default) and `true` both drive them. `false` simulates a
   * client that never implemented the 2026 pattern: it stops advertising
   * `elicitation` on a modern connection — where the MRTR bridge is the only
   * fulfiller, so advertising would be a capability nothing can honor — and
   * an `input_required` result surfaces as the upstream client's
   * `UNSUPPORTED_RESULT_TYPE` error instead of silently looping.
   *
   * Wired into the inspector via `hostConfig.mcpProfile.mrtrSupport`
   * (`"full"` | `"none"`). Modern-era only: MRTR does not exist before
   * `2026-07-28`, and a legacy connection keeps fulfilling elicitation
   * through the inbound `elicitation/create` bridge, which this knob does not
   * touch. WHICH elicitation modes an MRTR-capable client fulfills is a
   * separate, already-modeled fact (`clientCapabilities.elicitation`).
   */
  supportsMrtr?: boolean;
  /** Error handler for this server */
  onError?: (error: unknown) => void;
  /** Enable simple console logging of JSON-RPC traffic */
  logJsonRpc?: boolean;
  /** Custom logger for JSON-RPC traffic (overrides logJsonRpc) */
  rpcLogger?: RpcLogger;
  /**
   * Custom sink for HTTP exchanges (headers only). A DISTINCT channel from
   * `rpcLogger`: that one carries JSON-RPC bodies, this one carries the HTTP
   * envelope those bodies rode in — the `Mcp-*` mirrored headers a
   * `-32020 HeaderMismatch` is about. HTTP transports only; stdio never
   * reaches a fetch, so it emits nothing.
   */
  httpLogger?: HttpExchangeLogger;
  /**
   * The `fetch` the HTTP transport dials through, replacing the global one.
   *
   * WHY THIS EXISTS: hosted runs must not reach a private address, and
   * checking the URL the caller NAMED is not the same as checking the address
   * we end up dialling — a target can answer `302 Location:
   * http://169.254.169.254/`. Handing a DNS-pinned fetch
   * (`@mcpjam/sdk/oauth/node`'s `createPinnedStreamingFetch`) in here is what
   * puts the one real MCP connection under the same guard as the raw probes
   * beside it; before this existed, that connection followed redirects
   * unchecked and the conformance suite documented the hole in a comment.
   *
   * It is the INNERMOST fetch: the task-routing and HTTP-logging wrappers are
   * layered on top, so the bytes this sees are the bytes that leave. Ignored
   * by stdio, which never reaches a fetch. Absent ⇒ `globalThis.fetch`,
   * byte-identical to the behavior before this field.
   */
  baseFetch?: typeof fetch;
};

/**
 * Configuration for stdio-based MCP servers (subprocess)
 */
export type StdioServerConfig = BaseServerConfig & {
  /** Command to execute */
  command: string;
  /** Command arguments */
  args?: string[];
  /** Environment variables */
  env?: Record<string, string>;
  /** Child process stderr handling. Defaults to inherit when unspecified. */
  stderr?: StdioServerParameters["stderr"];
  /** Working directory for the stdio server process. */
  cwd?: StdioServerParameters["cwd"];

  // Discriminator fields - these should never be set for stdio
  url?: never;
  accessToken?: never;
  requestInit?: never;
  eventSourceInit?: never;
  authProvider?: never;
  reconnectionOptions?: never;
  sessionId?: never;
  preferSSE?: never;
  disableSseFallback?: never;
  refreshToken?: never;
  clientId?: never;
  clientSecret?: never;
  onUnauthorized?: never;
};

export type UnauthorizedRefreshResult = {
  accessToken: string;
};

export type UnauthorizedRefreshHandler = (args: {
  serverId: string;
  error: unknown;
}) => Promise<UnauthorizedRefreshResult>;

/**
 * Configuration for HTTP-based MCP servers (SSE or Streamable HTTP)
 */
export type HttpServerConfig = BaseServerConfig & {
  /** Server URL */
  url: string;
  /**
   * Access token for Bearer authentication.
   * If provided, adds `Authorization: Bearer <accessToken>` header to requests.
   */
  accessToken?: string;
  /** Additional request initialization options */
  requestInit?: StreamableHTTPClientTransportOptions["requestInit"];
  /** SSE-specific event source options */
  eventSourceInit?: SSEClientTransportOptions["eventSourceInit"];
  /** OAuth auth provider */
  authProvider?: StreamableHTTPClientTransportOptions["authProvider"];
  /** Refresh token for OAuth token exchange. Mutually exclusive with accessToken and authProvider. */
  refreshToken?: string;
  /** OAuth client ID. Required when refreshToken is set. */
  clientId?: string;
  /** OAuth client secret. Optional, used with refreshToken. */
  clientSecret?: string;
  /**
   * Optional 401 recovery hook. When provided for access-token based HTTP
   * configs, MCPClientManager calls it once after an operation fails with a
   * strict HTTP 401, then rebuilds the transport with the returned token.
   */
  onUnauthorized?: UnauthorizedRefreshHandler;
  /** Reconnection options for Streamable HTTP */
  reconnectionOptions?: StreamableHTTPClientTransportOptions["reconnectionOptions"];
  /** Session ID for Streamable HTTP */
  sessionId?: StreamableHTTPClientTransportOptions["sessionId"];
  /** Prefer SSE transport over Streamable HTTP */
  preferSSE?: boolean;
  /**
   * Opt out of the silent Streamable-HTTP → SSE downgrade. By default a
   * failed Streamable HTTP connect falls back to SSE, which is right for
   * ad-hoc URLs but wrong for a server whose transport was DECLARED
   * streamable-http (e.g. an Agent Plugins manifest): connecting over SSE
   * would misrepresent the server under test. When set, the Streamable HTTP
   * failure surfaces instead of being retried over SSE. Meaningful only when
   * Streamable HTTP is attempted first — inert alongside `preferSSE`, which
   * makes SSE the declared transport rather than a fallback.
   */
  disableSseFallback?: boolean;
  /**
   * Pinned MCP protocol version (wire literal that lands in `_meta` +
   * `MCP-Protocol-Version` header). Absent → SDK default at request
   * time. Stateful values (per `isStatelessProtocolVersion`) use the
   * legacy upstream Client + initialize handshake; stateless values
   * select the preview Streamable HTTP POST transport
   * (`StatelessMcpHttpPreviewClient`) and are incompatible with
   * `preferSSE`. Already validated by `isKnownProtocolVersion` at the
   * trust boundary (`local-server-resolver.ts` + Convex validator);
   * the manager does not re-validate. Resolved upstream (per-server
   * override > host default > undefined) and stamped onto the config
   * passed to `MCPClientManager`.
   */
  mcpProtocolVersion?: import("./mcp-protocol-version.js").McpProtocolVersion;

  // Discriminator fields - these should never be set for HTTP
  command?: never;
  args?: never;
  env?: never;
  stderr?: never;
  cwd?: never;
};

/**
 * Union type for all server configurations
 */
export type MCPServerConfig = StdioServerConfig | HttpServerConfig;

/**
 * Configuration map for multiple servers (serverId -> config)
 */
export type MCPClientManagerConfig = Record<string, MCPServerConfig>;

// ============================================================================
// Connection State Types
// ============================================================================

/**
 * Connection status for a server
 */
export type MCPConnectionStatus = "connected" | "connecting" | "disconnected";

/**
 * Summary information for a server
 */
export type ServerSummary = {
  id: string;
  status: MCPConnectionStatus;
  config?: MCPServerConfig;
};

/**
 * Shared state for managed client connections.
 *
 * `client` is typed as the `ManagedMcpClient` interface so the manager
 * can swap between the legacy upstream `Client` (via
 * `OfficialSdkClientAdapter`) and the stateless preview
 * (`StatelessMcpHttpPreviewClient`) without per-call branching.
 * `transport` is `undefined` for the stateless preview path — the
 * preview owns its own fetch and has no separate Transport object.
 */
export interface BaseClientState {
  client?: import("./managed-mcp-client.js").ManagedMcpClient;
  transport?: Transport;
  authProvider?: RefreshTokenOAuthProvider;
}

/**
 * Internal state for a managed client connection.
 * Retained for compatibility with external type consumers.
 */
export interface ManagedClientState extends BaseClientState {
  promise?: Promise<
    import("./managed-mcp-client.js").ManagedMcpClient
  >;
}

/**
 * Persistent server registration/configuration state.
 */
export interface RegisteredServerState {
  config: MCPServerConfig;
  timeout: number;
}

/**
 * Live connection state for a registered server.
 */
export interface LiveClientState extends BaseClientState {
  stdioStderrCleanup?: () => void;
  connectPromise?: Promise<
    import("./managed-mcp-client.js").ManagedMcpClient
  >;
  retryPromise?: Promise<
    import("./managed-mcp-client.js").ManagedMcpClient
  >;
  initializedClientCapabilities?: ClientCapabilityOptions;
}

// ============================================================================
// Logging Types
// ============================================================================

/**
 * Event passed to RPC loggers
 */
export type RpcLogEvent = {
  direction: "send" | "receive";
  message: unknown;
  serverId: string;
};

/**
 * Function type for JSON-RPC logging
 */
export type RpcLogger = (event: RpcLogEvent) => void;

// ============================================================================
// Progress Types
// ============================================================================

/**
 * Progress event from server operations
 */
export type ProgressEvent = {
  serverId: string;
  progressToken: string | number;
  progress: number;
  total?: number;
  message?: string;
};

/**
 * Function type for progress handling
 */
export type ProgressHandler = (event: ProgressEvent) => void;

// ============================================================================
// Constructor Options
// ============================================================================

/**
 * Options for MCPClientManager constructor
 */
export interface MCPClientManagerOptions {
  /** Default client name to report to servers */
  defaultClientName?: string;
  /** Default client version to report */
  defaultClientVersion?: string;
  /**
   * Default `clientInfo` extra fields (e.g. `title`) to advertise to servers.
   * Per-server `clientInfo.name` / `clientInfo.version` override this. Extra
   * keys here are merged into the per-server clientInfo at connect time so
   * future MCP spec additions don't require an SDK bump.
   */
  defaultClientInfoExtras?: Record<string, unknown>;
  /**
   * Default supported protocol versions accept-list. Per-server
   * `supportedProtocolVersions` overrides this. When neither is set, the
   * upstream Client's built-in `SUPPORTED_PROTOCOL_VERSIONS` default is
   * used and historical behavior is preserved verbatim.
   */
  defaultSupportedProtocolVersions?: string[];
  /** Default capabilities to advertise */
  defaultCapabilities?: ClientCapabilityOptions;
  /** Default request timeout in milliseconds */
  defaultTimeout?: number;
  /** Enable JSON-RPC logging for all servers by default */
  defaultLogJsonRpc?: boolean;
  /** Global JSON-RPC logger */
  rpcLogger?: RpcLogger;
  /** Global HTTP-exchange (headers-only) logger. See `httpLogger` on the
   *  server config for why this is a separate channel from `rpcLogger`. */
  httpLogger?: HttpExchangeLogger;
  /** Default transport `fetch` for every HTTP server. Per-server `baseFetch`
   *  overrides it. See `baseFetch` on the server config. */
  baseFetch?: typeof fetch;
  /** Global progress handler */
  progressHandler?: ProgressHandler;
  /**
   * Optional provenance sink for LOCAL cache serves. When set, every managed
   * connection is given an `ObservableResponseCache` (wrapping a fresh
   * in-memory store) and this callback fires whenever a cacheable verb is
   * answered from a still-fresh cached entry — a serve that costs ZERO wire
   * exchange. This is a DISTINCT channel from `rpcLogger`: cache hits never
   * touch the wire, so they must never be injected into the rpc/wire log
   * (that would make an invisible serve look like a real request).
   *
   * When unset, connections use the upstream default store and behavior is
   * byte-identical to not wiring a cache observer.
   */
  cacheEventLogger?: CacheEventLogger;
  /**
   * Optional per-connection negotiation-outcome sink (Phase 5 activation
   * telemetry). Fires once per connection attempt with the configured
   * negotiation mode, negotiated era/version, transport, outcome, and failure
   * class. The manager guards it (never throws into connect). Unset ⇒ no
   * telemetry, byte-identical connect behavior. The consumer stamps the
   * `surface` dimension and forwards to PostHog/Axiom.
   */
  negotiationOutcomeLogger?: NegotiationOutcomeLogger;
  /**
   * Optional accessor for the ambient OpenTelemetry trace context to
   * propagate into request `_meta` (the 2026-07-28 reserved `traceparent` /
   * `tracestate` / `baggage` keys). Called per request with the server id, so
   * an embedder whose tracer changes spans per operation gets the current one
   * without reconnecting.
   *
   * Propagation only. Returning `undefined` — the default, since MCPJam runs
   * no OpenTelemetry tracer — means the keys are ABSENT on the wire; the
   * manager never mints a trace or span id to fill them. Injection happens on
   * the modern era only, and a malformed value is dropped rather than
   * forwarded. See `trace-context.ts`.
   */
  traceContextProvider?: TraceContextProvider;
  /** Default retry policy for retryable manager operations */
  retryPolicy?: RetryPolicy;
  /**
   * Extra time budget (ms) granted to a `tools/call` while an elicitation is
   * pending for that server. The per-request timeout is a *server* budget: a
   * tool call blocked on a human must not die at it, but a hung server must.
   *
   * When any elicitation handler is installed for a server, `executeTool`
   * enforces the base timeout with its own watchdog that only accumulates
   * time while NO elicitation is pending, and separately caps the total time
   * spent suspended across all elicitations in that call at this value.
   *
   * Defaults to {@link DEFAULT_ELICITATION_TIMEOUT_EXTENSION_MS} (10 minutes).
   * Has no effect on servers without an elicitation handler.
   */
  elicitationTimeoutExtensionMs?: number;
  /**
   * When true, do not connect in the constructor; callers must use connectToServer
   * (e.g. connectReplayManagerServers) to avoid racing eager connects.
   */
  lazyConnect?: boolean;
}

// ============================================================================
// Tool Execution Types
// ============================================================================

/**
 * Arguments passed to tool execution
 */
export type ExecuteToolArguments = Record<string, unknown>;

/**
 * Options for task-augmented tool calls
 */
export type TaskOptions = {
  /** Time-to-live for the task in milliseconds */
  ttl?: number;
};

/**
 * Preferred executeTool options shape.
 */
export interface ExecuteToolRequest {
  /** Request options for the tool call */
  request?: ClientRequestOptions;
  /** Task options for task-augmented tool calls (2025-11-25 legacy wire only) */
  task?: TaskOptions;
  /**
   * SEP-2663 extension wire (2026-07-28+): declare, for THIS call, that the
   * client can handle a `CreateTaskResult`. The server decides whether to use
   * it; a plain result is still valid. There is no TTL — the server owns it.
   * Ignored on the legacy wire; an error on `wire: "none"`.
   */
  allowTaskResult?: boolean;
  /** Explicit retry policy for tool execution */
  retry?: RetryPolicy;
}

// ============================================================================
// Elicitation Types
// ============================================================================

/**
 * Handler for server-specific elicitation requests
 */
export type ElicitationHandler = (
  params: ElicitRequest["params"]
) => Promise<ElicitResult> | ElicitResult;

/**
 * Elicitation mode (MCP spec 2025-11-25). Absent on the wire ⇒ `"form"`.
 */
export type ElicitationMode = "form" | "url";

/**
 * Request passed to global elicitation callback
 */
export type ElicitationCallbackRequest = {
  requestId: string;
  message: string;
  schema: unknown;
  /** Task ID if this elicitation is related to a task (MCP Tasks spec 2025-11-25) */
  relatedTaskId?: string;
  /**
   * The server that issued this elicitation. Always populated by
   * `ElicitationManager.applyToClient`; optional so existing callback
   * implementations keep type-checking.
   */
  serverId?: string;
  /**
   * Elicitation mode. Absent ⇒ `"form"` (legacy behavior: every
   * pre-2025-11-25 elicitation is form mode).
   */
  mode?: ElicitationMode;
  /** URL to present to the user. URL mode only. */
  url?: string;
  /**
   * Server-chosen elicitation id, used by the server to correlate a
   * `notifications/elicitation/complete`. URL mode only. Never treat this
   * as a trusted key — it is chosen by the server.
   */
  elicitationId?: string;
};

/**
 * Global callback for handling elicitation requests
 */
export type ElicitationCallback = (
  request: ElicitationCallbackRequest
) => Promise<ElicitResult> | ElicitResult;

// ============================================================================
// MCP Tasks Types (Experimental - spec 2025-11-25)
// ============================================================================

/**
 * Task status values
 */
export type MCPTaskStatus = BaseTask["status"];

/**
 * MCP Task object
 */
export type MCPTask = BaseTask;

/**
 * Result from listing tasks
 */
export type MCPListTasksResult = BaseListTasksResult;

// ============================================================================
// Client Method Parameter Types
// ============================================================================

/**
 * Request options accepted by the manager's read verbs. Extends the upstream
 * `RequestOptions` with the SEP-2549 `cacheMode` so a caller can pick the
 * per-call cache disposition; ignored by verbs that are not cacheable (e.g.
 * `callTool`). See {@link CacheMode}.
 */
export type ClientRequestOptions = RequestOptions & { cacheMode?: CacheMode };
export type CallToolOptions = RequestOptions;
export type ListResourcesParams = Parameters<Client["listResources"]>[0];
export type ListResourceTemplatesParams = Parameters<
  Client["listResourceTemplates"]
>[0];
export type ReadResourceParams = Parameters<Client["readResource"]>[0];
export type SubscribeResourceParams = Parameters<
  Client["subscribeResource"]
>[0];
export type UnsubscribeResourceParams = Parameters<
  Client["unsubscribeResource"]
>[0];
export type ListPromptsParams = Parameters<Client["listPrompts"]>[0];
export type GetPromptParams = Parameters<Client["getPrompt"]>[0];
export type ListToolsResult = Awaited<ReturnType<Client["listTools"]>>;

// ============================================================================
// Result Type Aliases for Exports
// ============================================================================

export type MCPPromptListResult = Awaited<ReturnType<Client["listPrompts"]>>;
export type MCPPrompt = MCPPromptListResult["prompts"][number];
export type MCPGetPromptResult = Awaited<ReturnType<Client["getPrompt"]>>;
export type MCPResourceListResult = Awaited<
  ReturnType<Client["listResources"]>
>;
export type MCPResource = MCPResourceListResult["resources"][number];
export type MCPReadResourceResult = Awaited<ReturnType<Client["readResource"]>>;
export type MCPResourceTemplateListResult = Awaited<
  ReturnType<Client["listResourceTemplates"]>
>;
export type MCPResourceTemplate =
  MCPResourceTemplateListResult["resourceTemplates"][number];
export type MCPServerSummary = ServerSummary;

// ============================================================================
// Executable Tool Types
// ============================================================================

/**
 * An MCP tool with an execute function pre-wired to call the manager.
 * Extends the official MCP SDK Tool type.
 * Returned by MCPClientManager.getTools().
 */
/** Options for tool execution */
export interface ToolExecuteOptions {
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

export interface Tool extends BaseTool {
  /** Execute the tool with the given arguments */
  execute: (
    args: Record<string, unknown>,
    options?: ToolExecuteOptions
  ) => Promise<CallToolResult>;
  _meta?: {
    _serverId: string;
    [key: string]: unknown;
  };
}

// Re-export base type for users who need it
export type { BaseTool };

/**
 * AI SDK compatible tool set (Record<string, CoreTool>).
 * Returned by MCPClientManager.getToolsForAiSdk().
 * Can be passed directly to AI SDK's generateText().
 */
export type AiSdkTool = ToolSet;
