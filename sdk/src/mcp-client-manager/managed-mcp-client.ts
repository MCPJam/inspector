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
  CallToolResult,
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
  ProtocolEra,
  ReadResourceResult,
  Request,
  RequestOptions,
  ServerCapabilities,
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

  // ---- Tool calls ----
  // The five cacheable verbs (SEP-2549) widen their options to
  // `CacheableRequestOptions` so a caller can thread `cacheMode` through to
  // the underlying client. The upstream `Client` methods already accept this
  // shape; `OfficialSdkClientAdapter` forwards verbatim.
  listTools(
    params?: { cursor?: string },
    options?: CacheableRequestOptions
  ): Promise<ListToolsResult>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    options?: RequestOptions
  ): Promise<CallToolResult>;

  // ---- Generic request (used by tasks extension + future spec methods) ----
  // The upstream Protocol.request signature is `request(request, options)`
  // and uses the method-dispatch map for typed responses — there is no
  // schema overload in alpha.2. Keep the surface narrow; if the manager
  // ever needs an overloaded form, add it then.
  request<T = unknown>(req: Request, options?: RequestOptions): Promise<T>;

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

  // ---- Subscriptions (passthrough; stateless preview throws) ----
  subscribeResource(
    params: { uri: string },
    options?: RequestOptions
  ): Promise<EmptyResult>;
  unsubscribeResource(
    params: { uri: string },
    options?: RequestOptions
  ): Promise<EmptyResult>;

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
