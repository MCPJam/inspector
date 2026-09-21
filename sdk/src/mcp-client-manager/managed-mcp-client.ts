/**
 * `ManagedMcpClient` is the surface area `MCPClientManager` calls into for
 * every server connection. It exists so the manager can swap between the
 * legacy upstream `Client` (via `OfficialSdkClientAdapter`) and the
 * stateless 2026-07-28 preview transport
 * (`StatelessMcpHttpPreviewClient`) without per-call branching. Selection
 * is driven by the per-server `mcpProtocolVersion` pin (`McpProtocolVersion`
 * in `./mcp-protocol-version.ts`) — the factory uses
 * `isStatelessProtocolVersion` to route.
 *
 * **Coverage rationale.** The shape below was derived by grepping
 * `MCPClientManager.ts` for every `client.*` call site, plus
 * `elicitation.ts`'s `removeRequestHandler(ElicitRequestMethod)` cleanup
 * and the manager's `subscribeResource` / `unsubscribeResource`
 * passthrough. Omitting any method would crash the manager — there is no
 * `client?.foo()` fallback for unknown surface.
 *
 * **Disposable-by-design.** When upstream `@modelcontextprotocol/client`
 * adds stateless support, replacement is a one-line factory swap to a
 * new `OfficialSdkClientAdapter` configured for the new wire literal.
 * No manager-side churn, no product / UI / config unwind.
 */

import type {
  CacheableRequestOptions,
  CallToolRequestOptions,
  CallToolResult,
  Client,
  CompleteRequest,
  CompleteResult,
  EmptyResult,
  GetPromptResult,
  Implementation,
  ListPromptsResult,
  ListResourcesResult,
  ListResourceTemplatesResult,
  ListToolsResult,
  LoggingLevel,
  McpSubscription,
  ProtocolEra,
  SubscriptionFilter,
  ReadResourceResult,
  Request,
  RequestOptions,
  ServerCapabilities,
  StandardSchemaV1,
  Transport,
} from "@modelcontextprotocol/client";

/**
 * Connect-time options accepted by both adapters. Mirror of the upstream
 * `ClientOptions.connect` second argument; we don't tighten it to keep
 * the legacy adapter a pure pass-through.
 */
export interface ManagedMcpClientConnectOptions {
  timeout?: number;
  resumptionToken?: string;
  onresumptiontoken?: (token: string) => void;
}

/**
 * Notification / request handlers the manager registers. Both are
 * method-string keyed (`"elicitation/create"`, `"notifications/progress"`,
 * …); the underlying client dispatches on incoming `jsonrpc.method`.
 *
 * These are declared explicitly rather than derived from
 * `Parameters<Client["setNotificationHandler"]>` because beta.4 made those
 * methods **overloaded** (a typed method-literal form and a Standard-Schema
 * form). `Parameters<>` of an overload resolves to the *last* signature — the
 * schema-object form — which is not how the manager registers handlers. The
 * manager keys by method string and reads `.params` off a loose payload; the
 * `OfficialSdkClientAdapter` casts to upstream's typed form at the boundary.
 */
export type ManagedMcpClientNotificationMethod = string;
export interface ManagedMcpClientNotification {
  method: string;
  params?: Record<string, unknown>;
}
export type ManagedMcpClientNotificationHandler = (
  notification: ManagedMcpClientNotification
) => void;

export type ManagedMcpClientRequestMethod = string;
export interface ManagedMcpClientIncomingRequest {
  method: string;
  params?: Record<string, unknown>;
}
export type ManagedMcpClientRequestHandler = (
  request: ManagedMcpClientIncomingRequest
) => unknown | Promise<unknown>;

/**
 * The single surface the manager talks to. Every method here corresponds
 * to a verified call site in the SDK:
 *
 *   - `connect` / `close` / `onerror` / `onclose` — lifecycle, around
 *     `MCPClientManager.ts:1170-1192, 1267, 1362`.
 *   - `getServerCapabilities` / `getServerVersion` / `getInstructions` —
 *     manager state mirror at `:276, :317-319`.
 *   - `listTools` / `callTool` / `request` / `listResources` /
 *     `readResource` / `listResourceTemplates` / `listPrompts` /
 *     `getPrompt` / `ping` — RPC fan-out methods.
 *   - `subscribeResource` / `unsubscribeResource` — manager passthrough
 *     at `:700, :716`.
 *   - `setLoggingLevel` — manager auto-call at `:1225`.
 *   - `setNotificationHandler` / `setRequestHandler` — notification
 *     wiring + `applyToClient` paths.
 *   - `removeRequestHandler` — `elicitation.ts:168` close cleanup.
 *
 * Stateless preview behaviors (`StatelessMcpHttpPreviewClient`) are
 * documented per-method in that file. The interface itself stays
 * behavior-agnostic so it never has to know which adapter is wired.
 */
export interface ManagedMcpClient {
  /**
   * The client this one delegates to: the upstream `Client` for
   * `OfficialSdkClientAdapter`, the wrapped `ManagedMcpClient` for a decorator
   * such as `LogLevelMetaClient`. OPTIONAL — a hand-rolled implementation or a
   * test double may bottom out with no delegate at all.
   *
   * Declared so the delegation chain is a stated seam rather than a private
   * detail each consumer re-guesses. `tasks-ext-era-gate.ts` walks it to find
   * the upstream instance whose outbound era gate must be shadowed, so that a
   * directly-constructed adapter behaves like one built by
   * `managed-mcp-client-factory.ts`. Consumers MUST treat an absent `inner` as
   * "the chain ends here" and degrade, never throw.
   */
  readonly inner?: ManagedMcpClient | Client;

  // ---- Lifecycle ----
  connect(
    transport: Transport,
    options?: ManagedMcpClientConnectOptions
  ): Promise<void>;
  close(): Promise<void>;
  onerror?: (error: Error) => void;
  onclose?: () => void;

  // ---- Capability / identity getters ----
  getServerCapabilities(): ServerCapabilities | undefined;
  getServerVersion(): Implementation | undefined;
  getInstructions(): string | undefined;
  /**
   * The negotiated protocol era (`"legacy"` | `"modern"`), or `undefined`
   * before `initialize` completes. OPTIONAL because not every adapter can
   * report it — only the `OfficialSdkClientAdapter` passes it through from
   * upstream `Client.getProtocolEra()`. Consumers (the `LogLevelMetaClient`
   * decorator, the `getLoggingMechanism` helper) MUST treat an absent method
   * or `undefined` as "era unknown — do not apply modern-only behavior".
   */
  getProtocolEra?(): ProtocolEra | undefined;
  /**
   * The negotiated protocol version wire literal (e.g. `"2025-11-25"`), or
   * `undefined` before `initialize` completes. OPTIONAL for the same reason
   * as `getProtocolEra()`: only adapters over an upstream `Client` can report
   * it (upstream `Client.getNegotiatedProtocolVersion()`, client
   * `index.d.mts:2047`). Consumers MUST treat an absent method or
   * `undefined` as "version unknown" and fail closed rather than assuming a
   * version — never read the private `transport._protocolVersion`.
   */
  getNegotiatedProtocolVersion?(): string | undefined;

  // ---- Tool calls ----
  // The five cacheable verbs (SEP-2549) widen their options to
  // `CacheableRequestOptions` so a caller can thread `cacheMode` through to
  // the underlying client. The upstream `Client` methods already accept this
  // shape; `OfficialSdkClientAdapter` forwards verbatim.
  listTools(
    params?: { cursor?: string },
    options?: CacheableRequestOptions
  ): Promise<ListToolsResult>;
  // `CallToolRequestOptions` (not plain `RequestOptions`) so the manager can
  // reach upstream's `toolDefinition` escape hatch — the seam that decides
  // which `inputSchema` SEP-2243 `Mcp-Param-*` mirroring reads, and therefore
  // the only way to simulate a client that does not mirror at all.
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    options?: CallToolRequestOptions
  ): Promise<CallToolResult>;

  // ---- Generic request (used by tasks extension + future spec methods) ----
  // The upstream Protocol.request signature is `request(request, options)`
  // and uses the method-dispatch map for typed responses — there is no
  // schema overload in alpha.2. Keep the surface narrow; if the manager
  // ever needs an overloaded form, add it then.
  request<T = unknown>(req: Request, options?: RequestOptions): Promise<T>;

  /**
   * Explicit-schema request — the type-correct path for the modern
   * multi-round-trip (`input_required`) loop. Forwards to upstream
   * `Protocol.request`'s second overload
   * (`request(request, resultSchema, options)`, client `index.d.mts:2198`),
   * which validates a *complete* result against `resultSchema` while surfacing
   * a non-complete `input_required` result untouched (paired with
   * `withInputRequired(resultSchema)` + `options.allowInputRequired`).
   *
   * NEW seam (2026-07-28). It exists alongside — never replacing — the generic
   * `request<T>` above, whose method-dispatch typing cannot express an
   * `input_required` union (the SDK deliberately does not widen `ResultTypeMap`
   * for requesters). Decorators MUST forward it: `LogLevelMetaClient` injects
   * the modern per-request logging `_meta` here exactly as it does for the
   * other request-bearing methods.
   */
  requestWithSchema<TSchema extends StandardSchemaV1>(
    req: Request,
    resultSchema: TSchema,
    options?: RequestOptions
  ): Promise<StandardSchemaV1.InferOutput<TSchema>>;

  // ---- Resources ----
  listResources(
    params?: { cursor?: string },
    options?: CacheableRequestOptions
  ): Promise<ListResourcesResult>;
  readResource(
    params: { uri: string },
    options?: CacheableRequestOptions
  ): Promise<ReadResourceResult>;
  listResourceTemplates(
    params?: { cursor?: string },
    options?: CacheableRequestOptions
  ): Promise<ListResourceTemplatesResult>;

  // ---- Prompts ----
  listPrompts(
    params?: { cursor?: string },
    options?: CacheableRequestOptions
  ): Promise<ListPromptsResult>;
  getPrompt(
    params: { name: string; arguments?: Record<string, string> },
    options?: RequestOptions
  ): Promise<GetPromptResult>;

  // ---- Completions ----
  // Used by the conformance suite's `completion-complete` check. Passthrough
  // to upstream `Client.complete`; self-skips when the server does not
  // advertise the optional completions capability, so this is never invoked
  // against a server that lacks it.
  complete(
    params: CompleteRequest["params"],
    options?: RequestOptions
  ): Promise<CompleteResult>;

  // ---- Health ----
  ping(options?: RequestOptions): Promise<EmptyResult>;
  /**
   * `server/discover` (2026-07-28+): the modern era's only universally
   * available request, and therefore its liveness probe — `ping` was removed
   * from the 2026 vocabulary, so the upstream client refuses to send it on a
   * modern-classified connection (`MethodNotSupportedByProtocolVersion`).
   * Optional because non-upstream adapters (test doubles) may not carry it;
   * `MCPClientManager.pingServer` era-gates before reaching for it.
   */
  discover?(options?: RequestOptions): Promise<unknown>;

  // ---- Subscriptions (passthrough; stateless preview throws) ----
  subscribeResource(
    params: { uri: string },
    options?: RequestOptions
  ): Promise<EmptyResult>;
  unsubscribeResource(
    params: { uri: string },
    options?: RequestOptions
  ): Promise<EmptyResult>;
  /**
   * Opens a 2026-07-28 `subscriptions/listen` stream. OPTIONAL: only adapters
   * over an upstream `Client` can provide it, and it throws a typed
   * `SdkErrorCode.MethodNotSupportedByProtocolVersion` on a legacy connection.
   * Consumers MUST treat an absent method as "this connection has no modern
   * subscription stream" and fall back to the legacy per-URI RPCs — see
   * `SubscriptionCoordinator` in `./subscription-coordinator.ts`.
   */
  listen?(
    filter: SubscriptionFilter,
    options?: RequestOptions
  ): Promise<McpSubscription>;

  // ---- Logging (stateless preview is a no-op + warning) ----
  setLoggingLevel(level: LoggingLevel, options?: RequestOptions): Promise<void>;

  // ---- Handler registration (signatures mirror upstream Client) ----
  setNotificationHandler(
    method: ManagedMcpClientNotificationMethod,
    handler: ManagedMcpClientNotificationHandler
  ): void;
  setRequestHandler(
    method: ManagedMcpClientRequestMethod,
    handler: ManagedMcpClientRequestHandler
  ): void;
  removeRequestHandler(method: ManagedMcpClientRequestMethod): void;
}

/**
 * Sentinel error thrown by `StatelessMcpHttpPreviewClient` for surface
 * the preview cannot honor yet (resource subscriptions need
 * `subscriptions/listen`, server-initiated requests need MRTR,
 * `server/discover` auto-probe is deferred, 403 `insufficient_scope`
 * upscoping is deferred). "Not yet" — these are deferred-work gaps, not
 * permanent limits; the bare class is `NotYetSupportedInStateless`
 * rather than `NotSupportedInStateless` to signal that explicitly.
 * Thrown as a labeled subclass so manager call sites can catch + surface
 * as user errors rather than letting a silent no-op masquerade as a
 * working subscription.
 */
export class NotYetSupportedInStateless extends Error {
  constructor(method: string, reason?: string) {
    super(
      reason
        ? `Method "${method}" is not yet supported in the stateless MCP preview: ${reason}`
        : `Method "${method}" is not yet supported in the stateless MCP preview.`
    );
    this.name = "NotYetSupportedInStateless";
  }
}

/**
 * Sentinel thrown by `createManagedMcpClient` when the resolved
 * `mcpProtocolVersion` is stateless but the server config selects stdio
 * or legacy SSE. MCPJam's current stateless preview supports Streamable
 * HTTP POST only; failing fast at construction prevents a half-baked
 * client from failing mysteriously on the first call.
 */
export class StatelessRequiresHttpTransport extends Error {
  readonly transportKind: string;
  constructor(transportKind: string) {
    super(
      `MCPJam's current stateless preview requires Streamable HTTP POST; got transport kind "${transportKind}".`
    );
    this.name = "StatelessRequiresHttpTransport";
    this.transportKind = transportKind;
  }
}

/**
 * Sentinel thrown when `tools/list` returns paginated results during
 * header-discovery. Building a partial header map from only the first
 * page would silently omit `Mcp-Param-*` headers for tools that haven't
 * been listed yet — better to fail loud than fail silently. Real spec
 * limitation (not a preview gap), so no maturity tag.
 */
export class PaginatedToolHeaderDiscoveryUnsupported extends Error {
  constructor() {
    super(
      "Paginated tools/list is not supported during stateless MCP header discovery (Mcp-Param-*). Returning a partial header map would silently drop headers for unlisted tools."
    );
    this.name = "PaginatedToolHeaderDiscoveryUnsupported";
  }
}

/**
 * Sentinel thrown when a connection pinned to a modern protocol version meets
 * a server that does not offer it.
 *
 * In pin mode the upstream client requires `server/discover` to advertise the
 * pinned revision and does NOT fall back — by design, because the pin exists
 * to reproduce one specific client's wire behavior. The resulting
 * `SdkError(EraNegotiationFailed)` names the version it wanted, but the
 * manager then tries the SSE transport, that fails too (a modern-only server
 * answers `405`), and both failures were folded into one generic "failed to
 * connect using HTTP transports" message. What reached the user described the
 * SYMPTOM of the second attempt and never mentioned the version — so the one
 * fact that explains the failure, and the one setting that fixes it, were
 * both absent.
 *
 * This class carries them instead. `protocolVersion` is read from the
 * resolved config rather than parsed out of the upstream message: the manager
 * already knows what it pinned, and a wording change upstream must not be
 * able to silently empty this field.
 *
 * NOTE: the message wording is load-bearing. `describeError` matches
 * "which this client is pinned to" to resolve
 * `sdk/protocol_version_pin_unsupported` — error identity does not survive
 * the realm boundary between the SDK and the inspector's client bundle, so
 * the text is the only stable carrier. A test pins that round trip; reword
 * both sides together or not at all.
 */
export class ProtocolVersionPinUnsupported extends Error {
  readonly serverId: string;
  readonly protocolVersion: string;
  /**
   * What the server said it DOES speak, when it said so.
   *
   * Carried by two failure shapes: `UnsupportedProtocolVersionError` — raised
   * after `server/discover` parsed cleanly and listed no usable version — and
   * the legacy `initialize` refusal, whose message names the single version
   * the server's reply offered. A pin refusal that carried no version at all
   * yields `[]`, and the message simply omits the clause rather than guessing.
   */
  readonly supportedVersions: readonly string[];
  constructor(
    serverId: string,
    protocolVersion: string,
    options?: { cause?: unknown; supportedVersions?: readonly string[] }
  ) {
    const supported = options?.supportedVersions ?? [];
    super(
      `MCP server "${serverId}" doesn't support MCP protocol version ${protocolVersion}, which this client is pinned to.${
        supported.length > 0 ? ` It offers ${supported.join(", ")}.` : ""
      }`,
      options
    );
    this.name = "ProtocolVersionPinUnsupported";
    this.serverId = serverId;
    this.protocolVersion = protocolVersion;
    this.supportedVersions = supported;
  }
}
