/**
 * `StatelessMcpHttpPreviewClient` — own-fetch implementation of
 * `ManagedMcpClient` for the experimental DRAFT-2026-v1 stateless MCP
 * transport. Does NOT extend upstream `Client` / `Protocol` /
 * `Transport`; upstream's private fields and missing per-send header
 * hooks make subclassing untenable (see `upstream_v2alpha_extension_points`
 * memory entry).
 *
 * Owns:
 *   - JSON-RPC message construction + ID allocation
 *   - `_meta.io.modelcontextprotocol/*` injection (locked content,
 *     merged with caller `_meta`)
 *   - SEP-2243 required headers (`MCP-Protocol-Version`, `Mcp-Method`,
 *     `Mcp-Name`, `Mcp-Param-*`)
 *   - Per-request SSE response parsing (synchronous — final response
 *     terminates the stream)
 *   - Bearer / OAuth refresh on 401
 *   - `mcp-session-id` response detection + warn + discard (never
 *     echoed)
 *   - Tool-header-map cache (`tool-header-map.ts`)
 *
 * Also owns:
 *   - `server/discover` (SEP-2575) — fired during `connect()` to validate
 *     the server speaks our `protocolVersion` and to populate
 *     `serverInfo` / `serverCapabilities` / `instructions` for the manager's
 *     `getInitializationInfo` (which is what the inspector UI reads to show
 *     the server's name + capability flags). A `-32004` from this probe
 *     means the server doesn't speak our version; the throw propagates as a
 *     connect failure with the error envelope intact for the wire log.
 *     Opt out with `discoverOnConnect: false` for unit-test / raw-client
 *     callers that want no auto-probe.
 *
 * Does NOT own (intentionally deferred — see plan "Known limitations"):
 *   - `initialize` / `initialized` (no handshake in stateless)
 *   - MRTR / `InputRequiredResult` (server-initiated requests)
 *   - `subscriptions/listen` (throws `NotYetSupportedInStateless`)
 *   - Resumption tokens (`resumptionToken` / `onresumptiontoken` throw
 *     a labeled error)
 *   - Backward-compat probes against pre-DRAFT-2026-v1 servers
 */

import type {
  CallToolResult,
  EmptyResult,
  GetPromptResult,
  Implementation,
  ListPromptsResult,
  ListResourcesResult,
  ListResourceTemplatesResult,
  ListToolsResult,
  LoggingLevel,
  ReadResourceResult,
  Request,
  RequestOptions,
  ServerCapabilities,
  Transport,
} from "@modelcontextprotocol/client";
import type { RpcLogger } from "./types.js";
import type {
  ManagedMcpClient,
  ManagedMcpClientConnectOptions,
  ManagedMcpClientNotificationHandler,
  ManagedMcpClientNotificationMethod,
  ManagedMcpClientRequestHandler,
  ManagedMcpClientRequestMethod,
} from "./managed-mcp-client.js";
import { NotYetSupportedInStateless } from "./managed-mcp-client.js";
import {
  ToolHeaderMap,
  parseToolsForHeaderMap,
  assertNotPaginated,
  type ParsedTool,
} from "./tool-header-map.js";
import type { McpProtocolVersion } from "./mcp-protocol-version.js";

/**
 * Default wire literal emitted in `_meta` and the `MCP-Protocol-Version`
 * header when the constructor's `protocolVersion` option is omitted. The
 * actual literal at request time always comes from `this.protocolVersion`
 * so a server pinned to a future stateless version (e.g. the post-RC
 * finalized `2026-07-28` date) routes through the same class.
 */
export const STATELESS_DRAFT_2026_V1 = "DRAFT-2026-v1" as const;

/**
 * Capabilities the preview commits to honoring. Locked per
 * `advertise_equals_enforce` — emitted on every request body's
 * `_meta.io.modelcontextprotocol/clientCapabilities`. No `roots`,
 * `sampling`, or `logging` since the preview can't fulfill them; the
 * manager's automatic `setLoggingLevel("debug")` is no-op'd here AND
 * guarded at the call site in PR3.
 */
const LOCKED_CLIENT_CAPABILITIES = {
  extensions: {
    "io.modelcontextprotocol/apps": {
      mimeTypes: ["text/html;profile=mcp-app"],
    },
  },
} as const;

const META_NAMESPACE = "io.modelcontextprotocol";
const PROTOCOL_VERSION_META_KEY = `${META_NAMESPACE}/protocolVersion`;
const CLIENT_INFO_META_KEY = `${META_NAMESPACE}/clientInfo`;
const CLIENT_CAPABILITIES_META_KEY = `${META_NAMESPACE}/clientCapabilities`;

const SESSION_ID_HEADER_LOWER = "mcp-session-id";
const MCP_PROTOCOL_VERSION_HEADER = "MCP-Protocol-Version";
const MCP_METHOD_HEADER = "Mcp-Method";
const MCP_NAME_HEADER = "Mcp-Name";

/**
 * Methods that require `Mcp-Name: <params.name | params.uri>` per
 * SEP-2243. Kept as a Set so adding a future header-name method is a
 * one-line change without rebuilding a switch.
 */
const METHODS_REQUIRING_NAME_HEADER = new Set<string>([
  "tools/call",
  "resources/read",
  "prompts/get",
]);

/**
 * Construction options. All HTTP details must be resolved before
 * construction (per `upstream_v2alpha_extension_points` and plan
 * §"Construction timing") — the preview owns its own fetch and cannot
 * rebuild headers/auth from manager state after the fact.
 */
export interface StatelessMcpHttpPreviewClientOptions {
  /** Target server URL (already resolved). */
  url: URL | string;
  /** `Implementation` to emit in `_meta.io.modelcontextprotocol/clientInfo`. */
  clientInfo: Implementation;
  /**
   * Wire literal to emit in `_meta.io.modelcontextprotocol/protocolVersion`
   * and the `MCP-Protocol-Version` header. Defaults to
   * `STATELESS_DRAFT_2026_V1`. Parameterized so the same class serves
   * future stateless drafts without a subclass; the factory passes the
   * resolved `mcpProtocolVersion` here.
   */
  protocolVersion?: McpProtocolVersion;
  /** Static headers (e.g. project-level overrides). Bearer is set via authProvider. */
  staticHeaders?: Record<string, string>;
  /**
   * Authentication. Either a bearer token (string) or a callback returning
   * one; the callback variant is used for OAuth where the token might
   * refresh. Returning `undefined` skips the `Authorization` header.
   */
  getAccessToken?: () => string | undefined | Promise<string | undefined>;
  /**
   * Single-shot 401 recovery — analogous to the upstream Client + auth
   * provider flow. Implementations should refresh credentials and return
   * a fresh access token, OR return `undefined` to give up (preview
   * surfaces the underlying 401 verbatim).
   */
  on401?: () => Promise<string | undefined>;
  /**
   * RPC logger for parity with `wrapTransportForLogging` on the legacy
   * path. The preview owns fetch, so we have to call the logger by hand
   * at send / receive boundaries.
   */
  rpcLogger?: RpcLogger;
  /** Server identifier used by the rpcLogger; mirror of stdio/HTTP wrapper arg. */
  serverId: string;
  /**
   * If the response carries `mcp-session-id`, the preview marks it as
   * non-conforming via this callback. Optional — manager-side hook for
   * surfacing the warning in conformance output.
   */
  onSessionIdResponse?: (sessionId: string) => void;
  /**
   * Whether `connect()` should fire `server/discover` (SEP-2575) to
   * validate the server speaks `protocolVersion` and populate
   * `serverInfo` / `serverCapabilities` / `instructions`. Default `true` —
   * this is what produces visible wire activity on the inspector UI's
   * connect path and what surfaces `-32004 UnsupportedProtocolVersionError`
   * as a real connection failure. Set `false` for unit tests or callers
   * that want a raw wire client with no auto-probe.
   */
  discoverOnConnect?: boolean;
}

/**
 * Result of `server/discover` per SEP-2575 / draft `DiscoverResult` schema.
 * Carries the negotiated `protocolVersion`, the server's `serverInfo` +
 * `capabilities` + optional `instructions`, and the full
 * `supportedVersions` list so a client can retry against a mutually
 * supported version on its own. The field name is `capabilities` (NOT
 * `serverCapabilities` — that's the pre-2026 negotiation-flow naming;
 * SEP-2575 deliberately uses `capabilities` to match the rest of the
 * draft's result shapes).
 */
export interface DiscoverResult {
  protocolVersion: string;
  serverInfo: Implementation;
  capabilities: ServerCapabilities;
  supportedVersions?: string[];
  instructions?: string;
}

/** JSON-RPC envelope shapes (subset of upstream types). */
interface JsonRpcRequestBody {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}
interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: number | string;
  result: unknown;
}
interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: number | string;
  error: { code: number; message: string; data?: unknown };
}
interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}
type JsonRpcMessage =
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse
  | JsonRpcNotification;

interface SendOptions {
  signal?: AbortSignal;
  timeout?: number;
  /** Map params.name / params.uri → header value for METHODS_REQUIRING_NAME_HEADER. */
  nameHeader?: string;
  /** Additional `Mcp-Param-*` headers derived for `tools/call`. */
  extraHeaders?: Record<string, string>;
  /** Caller-provided `_meta` to merge with our locked keys. */
  callerMeta?: Record<string, unknown>;
  /** Caller progress handler — preview injects progressToken + relays notifications/progress. */
  onProgress?: (progress: unknown) => void;
}

export class StatelessMcpHttpPreviewClient implements ManagedMcpClient {
  private nextRequestId = 1;
  private readonly url: URL;
  private readonly clientInfo: Implementation;
  private readonly protocolVersion: McpProtocolVersion;
  private readonly staticHeaders: Record<string, string>;
  private readonly getAccessToken?: () => string | undefined | Promise<string | undefined>;
  private readonly on401?: () => Promise<string | undefined>;
  private readonly rpcLogger?: RpcLogger;
  private readonly serverId: string;
  private readonly onSessionIdResponse?: (sessionId: string) => void;
  private readonly discoverOnConnect: boolean;
  private readonly toolHeaderMap = new ToolHeaderMap();
  private readonly inFlightAborts = new Set<AbortController>();
  private closed = false;
  private connected = false;
  private nonConformingSessionIdSeen = false;
  // Populated by `server/discover` during `connect()` (when
  // `discoverOnConnect` is true). Stay undefined for raw-client callers
  // that opted out; capability getters return that undefined verbatim so
  // the manager + inspector UI distinguish "unknown" from a real synthetic.
  // Field name `discoveredCapabilities` matches the spec's
  // `DiscoverResult.capabilities` (SEP-2575); the legacy `serverCapabilities`
  // name belongs to the pre-2026 initialize result and is intentionally NOT
  // reused here.
  private discoveredServerInfo: Implementation | undefined;
  private discoveredCapabilities: ServerCapabilities | undefined;
  private discoveredInstructions: string | undefined;

  // Per-method handlers — preview is client-only (no server-initiated
  // requests in scope), so these are accepted-but-never-invoked. The
  // map keeps `removeRequestHandler` honest (no throw on cleanup).
  private requestHandlers = new Map<
    ManagedMcpClientRequestMethod,
    ManagedMcpClientRequestHandler
  >();
  private notificationHandlers = new Map<
    ManagedMcpClientNotificationMethod,
    ManagedMcpClientNotificationHandler
  >();

  onerror?: (error: Error) => void;
  onclose?: () => void;

  constructor(opts: StatelessMcpHttpPreviewClientOptions) {
    this.url = typeof opts.url === "string" ? new URL(opts.url) : opts.url;
    this.clientInfo = opts.clientInfo;
    this.protocolVersion = opts.protocolVersion ?? STATELESS_DRAFT_2026_V1;
    this.staticHeaders = { ...(opts.staticHeaders ?? {}) };
    this.getAccessToken = opts.getAccessToken;
    this.on401 = opts.on401;
    this.rpcLogger = opts.rpcLogger;
    this.serverId = opts.serverId;
    this.onSessionIdResponse = opts.onSessionIdResponse;
    this.discoverOnConnect = opts.discoverOnConnect ?? true;
  }

  // ---- Lifecycle ----
  async connect(
    _transport: Transport,
    _options?: ManagedMcpClientConnectOptions,
  ): Promise<void> {
    // Stateless: no initialize round-trip, no transport.start(). The
    // upstream `Transport` argument is accepted for interface parity
    // with `OfficialSdkClientAdapter`. We validate basic invariants,
    // mark ready, then fire `server/discover` (SEP-2575) to populate
    // server identity + capabilities AND to validate the server speaks
    // our `protocolVersion`. A `-32004 UnsupportedProtocolVersionError`
    // from discover propagates as a connect failure with the error
    // envelope intact — that's how the inspector surfaces "this server
    // doesn't speak DRAFT-2026-v1" instead of a misleading "Connected".
    if (this.closed) {
      throw new Error("StatelessMcpHttpPreviewClient: connect() after close()");
    }
    if (
      _options?.resumptionToken !== undefined ||
      _options?.onresumptiontoken !== undefined
    ) {
      throw new NotYetSupportedInStateless(
        "connect.resumption",
        "TransportSendOptions resumption is not implemented in the preview",
      );
    }
    // Mark `connected` BEFORE the discover send so the send() guard
    // (which the preview doesn't currently enforce, but might in
    // future) doesn't reject. `connected` is also what
    // `getServerCapabilities()` checks before returning the synthetic
    // fallback; flipping it now means a successful discover
    // immediately overwrites the synthetic.
    this.connected = true;
    if (!this.discoverOnConnect) return;
    try {
      const result = await this.send<DiscoverResult>(
        "server/discover",
        undefined,
        // No caller-provided RequestOptions for the auto-probe — use the
        // SendOptions defaults. `_options?.timeout` exists on the
        // connect-time options too but it's the upstream Transport
        // timeout, not a per-RPC one; let the default request timeout
        // apply so connect doesn't hang on a slow `server/discover`.
        {},
      );
      this.discoveredServerInfo = result.serverInfo;
      this.discoveredCapabilities = result.capabilities;
      this.discoveredInstructions = result.instructions;
    } catch (err) {
      // Roll back the connected flag so a retried connect() runs
      // discover again instead of treating us as already-up. The error
      // envelope (and the matching wire log event) is what callers see.
      this.connected = false;
      throw err;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.connected = false;
    for (const ac of this.inFlightAborts) {
      try {
        ac.abort();
      } catch {
        // ignore — closing a never-started AbortController is fine
      }
    }
    this.inFlightAborts.clear();
    this.toolHeaderMap.clear();
    // Mirror upstream: onclose fires on close().
    try {
      this.onclose?.();
    } catch {
      // ignore — listener errors must not break shutdown
    }
  }

  // ---- Capability / identity getters ----
  // All three return the discover-populated value when `connect()` ran
  // discover (the default). When `discoverOnConnect: false` was set OR
  // discover hasn't run yet, return undefined — same shape the legacy
  // adapter uses pre-connect, and what `MCPClientManager.getInitializationInfo`
  // already handles.
  //
  // Note: `ManagedMcpClient` keeps the method name `getServerCapabilities()`
  // for interface parity with the legacy upstream `Client`, but the
  // returned value comes from `DiscoverResult.capabilities` (the spec
  // field name in SEP-2575). The method-name / field-name asymmetry is
  // load-bearing — don't rename the method or the manager's
  // `getInitializationInfo` reader breaks.
  getServerCapabilities(): ServerCapabilities | undefined {
    if (!this.connected) return undefined;
    return this.discoveredCapabilities;
  }
  getServerVersion(): Implementation | undefined {
    return this.discoveredServerInfo;
  }
  getInstructions(): string | undefined {
    return this.discoveredInstructions;
  }

  // ---- Discovery (SEP-2575) ----
  /**
   * Sends `server/discover`. Used internally by `connect()` (when
   * `discoverOnConnect` is true) and exposed for callers that want to
   * re-probe after construction (e.g., after a transport-level retry).
   * Side-effect-free at the SDK layer beyond the wire log; does NOT
   * update the cached `serverInfo` / `serverCapabilities` / `instructions`
   * fields — that's only what `connect()` does. Callers that want the
   * fresh result reflected in `getServerCapabilities()` should reconnect.
   */
  async discover(options?: RequestOptions): Promise<DiscoverResult> {
    return await this.send<DiscoverResult>("server/discover", undefined, {
      ...(options ?? {}),
    });
  }

  // ---- Tool calls ----
  async listTools(
    params?: { cursor?: string },
    options?: RequestOptions,
  ): Promise<ListToolsResult> {
    const result = await this.send<ListToolsResult>("tools/list", params, {
      ...(options ?? {}),
    });
    // Populate the header map. Cursor support is in scope for `listTools`
    // itself (callers can paginate), but for our header-discovery
    // shortcut (lazy refresh inside `callTool`) we fail if the server
    // paginates. The plain `listTools` call still returns the page.
    const parsed = parseToolsForHeaderMap(
      (result.tools as ParsedTool[]) ?? [],
    );
    for (const w of parsed.warnings) this.warn(w);
    for (const toolName of (result.tools as { name: string }[]) ?? []) {
      if (!parsed.entries.has(toolName.name)) {
        this.toolHeaderMap.recordExcluded(toolName.name);
      }
    }
    const ttlMs = extractTtlMs(result);
    this.toolHeaderMap.update(parsed.entries, ttlMs);

    // Filter out excluded tools from the surface we expose. The model
    // must NOT pick a tool whose Mcp-Param-* requirements we can't
    // satisfy — per `filter_at_advertise_not_dispatch`.
    if (this.toolHeaderMap.getExcludedTools().size > 0) {
      const excluded = this.toolHeaderMap.getExcludedTools();
      return {
        ...result,
        tools: (result.tools as { name: string }[] | undefined)?.filter(
          (t) => !excluded.has(t.name),
        ) as ListToolsResult["tools"],
      };
    }
    return result;
  }

  async callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    options?: RequestOptions,
  ): Promise<CallToolResult> {
    // Lazy header-map refresh. The wire-spec consequence is that the
    // FIRST callTool after construction (or after TTL expiry) implicitly
    // triggers a tools/list — without that, we'd miss Mcp-Param-*
    // headers the server requires.
    if (!this.toolHeaderMap.isFresh()) {
      // Single-page only during header discovery — see
      // `PaginatedToolHeaderDiscoveryUnsupported`.
      const discovery = await this.send<ListToolsResult>(
        "tools/list",
        undefined,
        options ?? {},
      );
      assertNotPaginated(discovery as { nextCursor?: string | null });
      const parsed = parseToolsForHeaderMap(
        (discovery.tools as ParsedTool[]) ?? [],
      );
      for (const w of parsed.warnings) this.warn(w);
      for (const toolName of (discovery.tools as { name: string }[]) ?? []) {
        if (!parsed.entries.has(toolName.name)) {
          this.toolHeaderMap.recordExcluded(toolName.name);
        }
      }
      this.toolHeaderMap.update(parsed.entries, extractTtlMs(discovery));
    }

    const { headers, bodyArguments } = this.toolHeaderMap.deriveHeaders(
      params.name,
      params.arguments,
    );

    return await this.send<CallToolResult>(
      "tools/call",
      bodyArguments !== undefined
        ? { name: params.name, arguments: bodyArguments }
        : { name: params.name },
      {
        ...(options ?? {}),
        extraHeaders: headers,
        nameHeader: params.name,
      },
    );
  }

  async request<T = unknown>(
    req: Request,
    options?: RequestOptions,
  ): Promise<T> {
    return (await this.send<T>(
      req.method,
      req.params as Record<string, unknown> | undefined,
      options ?? {},
    )) as T;
  }

  async listResources(
    params?: { cursor?: string },
    options?: RequestOptions,
  ): Promise<ListResourcesResult> {
    return await this.send<ListResourcesResult>(
      "resources/list",
      params,
      options ?? {},
    );
  }

  async readResource(
    params: { uri: string },
    options?: RequestOptions,
  ): Promise<ReadResourceResult> {
    return await this.send<ReadResourceResult>("resources/read", params, {
      ...(options ?? {}),
      nameHeader: params.uri,
    });
  }

  async listResourceTemplates(
    params?: { cursor?: string },
    options?: RequestOptions,
  ): Promise<ListResourceTemplatesResult> {
    return await this.send<ListResourceTemplatesResult>(
      "resources/templates/list",
      params,
      options ?? {},
    );
  }

  async listPrompts(
    params?: { cursor?: string },
    options?: RequestOptions,
  ): Promise<ListPromptsResult> {
    return await this.send<ListPromptsResult>(
      "prompts/list",
      params,
      options ?? {},
    );
  }

  async getPrompt(
    params: { name: string; arguments?: Record<string, string> },
    options?: RequestOptions,
  ): Promise<GetPromptResult> {
    return await this.send<GetPromptResult>("prompts/get", params, {
      ...(options ?? {}),
      nameHeader: params.name,
    });
  }

  async ping(options?: RequestOptions): Promise<EmptyResult> {
    return await this.send<EmptyResult>("ping", undefined, options ?? {});
  }

  // ---- Subscriptions: throw, don't silently no-op ----
  async subscribeResource(): Promise<EmptyResult> {
    throw new NotYetSupportedInStateless(
      "resources/subscribe",
      "long-lived subscriptions require subscriptions/listen which is out of scope",
    );
  }
  async unsubscribeResource(): Promise<EmptyResult> {
    throw new NotYetSupportedInStateless(
      "resources/unsubscribe",
      "long-lived subscriptions require subscriptions/listen which is out of scope",
    );
  }

  // ---- Logging: no-op + warn (capabilities don't advertise logging) ----
  async setLoggingLevel(
    _level: LoggingLevel,
    _options?: RequestOptions,
  ): Promise<void> {
    this.warn(
      "setLoggingLevel is a no-op in the DRAFT-2026-v1 stateless preview (clientCapabilities omits logging).",
    );
  }

  // ---- Handlers ----
  setNotificationHandler(
    method: ManagedMcpClientNotificationMethod,
    handler: ManagedMcpClientNotificationHandler,
  ): void {
    this.notificationHandlers.set(method, handler);
  }
  setRequestHandler(
    method: ManagedMcpClientRequestMethod,
    handler: ManagedMcpClientRequestHandler,
  ): void {
    this.requestHandlers.set(method, handler);
  }
  removeRequestHandler(method: ManagedMcpClientRequestMethod): void {
    this.requestHandlers.delete(method);
  }

  // ---- Internals ----
  private async send<T>(
    method: string,
    params: Record<string, unknown> | undefined,
    opts: RequestOptions & SendOptions,
  ): Promise<T> {
    if (this.closed) {
      throw new Error(
        "StatelessMcpHttpPreviewClient: send() after close()",
      );
    }

    const id = this.nextRequestId++;

    // Merge `_meta` — caller wins for non-namespaced keys, we win for
    // the locked io.modelcontextprotocol/* keys. progressToken /
    // traceparent / tracestate / baggage / related-task IDs come in
    // via params._meta on the caller side and MUST survive.
    const callerMeta = (params?._meta as Record<string, unknown> | undefined) ?? {};
    const onProgress = (opts as RequestOptions).onprogress;
    let effectiveCallerMeta: Record<string, unknown> = { ...callerMeta };
    if (onProgress !== undefined && callerMeta.progressToken === undefined) {
      // Match upstream Protocol.request: generate a progress token so
      // notifications/progress for this request can be correlated. Use
      // the request id — simplest unique value scoped to this client.
      effectiveCallerMeta = { ...effectiveCallerMeta, progressToken: id };
    }
    const mergedMeta: Record<string, unknown> = {
      ...effectiveCallerMeta,
      [PROTOCOL_VERSION_META_KEY]: this.protocolVersion,
      [CLIENT_INFO_META_KEY]: this.clientInfo,
      [CLIENT_CAPABILITIES_META_KEY]: LOCKED_CLIENT_CAPABILITIES,
    };

    const body: JsonRpcRequestBody = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined || Object.keys(mergedMeta).length > 0
        ? {
            params: {
              ...(params ?? {}),
              _meta: mergedMeta,
            },
          }
        : {}),
    };

    const headers = await this.buildHeaders(method, opts);
    const abortController = new AbortController();
    this.inFlightAborts.add(abortController);
    const callerSignal = (opts as RequestOptions).signal;
    if (callerSignal) {
      if (callerSignal.aborted) abortController.abort(callerSignal.reason);
      else
        callerSignal.addEventListener(
          "abort",
          () => abortController.abort(callerSignal.reason),
          { once: true },
        );
    }
    const timeoutMs = (opts as RequestOptions).timeout;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs !== undefined) {
      timeoutHandle = setTimeout(
        () =>
          abortController.abort(
            new Error(`Request timed out after ${timeoutMs}ms`),
          ),
        timeoutMs,
      );
    }

    this.rpcLogger?.({ direction: "send", message: body, serverId: this.serverId });
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        body: JSON.stringify(body),
        headers,
        signal: abortController.signal,
      });

      // 401 single-shot refresh — analog of upstream's auth provider
      // path. Only the OAuth (callback-token) variant participates;
      // static-bearer setups surface the 401 raw because there's
      // nothing to refresh.
      if (response.status === 401 && this.on401) {
        const refreshed = await this.on401();
        if (refreshed) {
          const retryHeaders = await this.buildHeaders(method, opts, refreshed);
          this.rpcLogger?.({ direction: "send", message: body, serverId: this.serverId });
          response = await fetch(this.url, {
            method: "POST",
            body: JSON.stringify(body),
            headers: retryHeaders,
            signal: abortController.signal,
          });
        }
      }
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      this.inFlightAborts.delete(abortController);
    }

    // Session-id detection — discard, warn, mark non-conforming. Per
    // plan §"What stateless means" the preview never echoes a session
    // id back, so there's nothing else to do here.
    const seenSessionId = response.headers.get(SESSION_ID_HEADER_LOWER);
    if (seenSessionId) {
      this.nonConformingSessionIdSeen = true;
      this.warn(
        `Server returned mcp-session-id: "${seenSessionId}" on a stateless request. Discarded. Server is non-conforming under DRAFT-2026-v1.`,
      );
      this.onSessionIdResponse?.(seenSessionId);
    }

    const contentType = response.headers.get("content-type") ?? "";
    let envelope: JsonRpcMessage;
    if (contentType.includes("text/event-stream")) {
      envelope = await this.consumeSseResponse(response, id, opts);
    } else {
      const text = await response.text();
      envelope = parseSingleMessage(text);
    }

    // Log the raw envelope BEFORE unwrap-and-maybe-throw. Without this,
    // every error response (`-32004 UnsupportedProtocolVersion` from a
    // stateful server, `-32001 HeaderMismatch`, etc.) skips the receive
    // logger because `unwrapJsonRpcResult` throws on the `error` shape,
    // and the wire-log panel — the user's only diagnostic surface for
    // protocol-level failures — stays empty. Spec doesn't distinguish
    // success from error envelopes for logging purposes; both are
    // valid JSON-RPC responses the server sent us.
    this.rpcLogger?.({
      direction: "receive",
      message: envelope as unknown,
      serverId: this.serverId,
    });

    return this.unwrapJsonRpcResult<T>(envelope, id);
  }

  /**
   * Drains a per-request SSE response stream and returns the terminal
   * JSON-RPC envelope (success OR error — `unwrap` happens at the
   * caller so the receive logger sees the raw envelope first). Throws
   * only on transport-level violations (missing body, server-initiated
   * request mid-stream, id mismatch, stream-without-response).
   */
  private async consumeSseResponse(
    response: Response,
    requestId: number | string,
    opts: SendOptions,
  ): Promise<JsonRpcMessage> {
    if (!response.body) {
      throw new Error(
        "StatelessMcpHttpPreviewClient: SSE response has no body",
      );
    }
    const reader = response.body
      .pipeThrough(new TextDecoderStream())
      .getReader();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        // SSE frames are separated by a blank line. Parse complete
        // frames; leave the trailing partial in `buffer`.
        let sepIndex: number;
        while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sepIndex);
          buffer = buffer.slice(sepIndex + 2);
          const dataPayload = extractSseDataPayload(frame);
          if (dataPayload === undefined) continue;
          const message = parseSingleMessage(dataPayload);
          // Per-request stream: independent server-to-client JSON-RPC
          // requests are not supported in the preview (MRTR is out of
          // scope). If we see one, surface as an error rather than
          // attempt to dispatch.
          if ("method" in message && "id" in message) {
            throw new Error(
              "StatelessMcpHttpPreviewClient: server-initiated JSON-RPC request received on response stream — MRTR is not supported.",
            );
          }
          if ("method" in message) {
            // Notification — dispatch progress/message handlers if
            // registered; otherwise drop.
            this.handleStreamingNotification(message, opts);
            continue;
          }
          // It's a response. Either success or error. If id matches,
          // that's the terminal frame — hand it back raw so the caller
          // can log it before unwrap.
          if ((message as { id?: unknown }).id === requestId) {
            return message as JsonRpcMessage;
          }
          // Other-id response on a per-request stream is a protocol
          // error; surface it.
          throw new Error(
            `StatelessMcpHttpPreviewClient: unexpected response id on per-request SSE stream (got ${(message as { id?: unknown }).id}, expected ${requestId})`,
          );
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
    }
    throw new Error(
      "StatelessMcpHttpPreviewClient: SSE stream ended without a final response",
    );
  }

  private handleStreamingNotification(
    msg: JsonRpcNotification,
    opts: SendOptions,
  ): void {
    if (msg.method === "notifications/progress" && opts.onProgress) {
      try {
        opts.onProgress(msg.params);
      } catch (err) {
        this.warn(`onProgress handler threw: ${formatErr(err)}`);
      }
      return;
    }
    const handler = this.notificationHandlers.get(
      msg.method as ManagedMcpClientNotificationMethod,
    );
    if (handler) {
      try {
        // Notification handler is async-or-sync, return value ignored.
        Promise.resolve(handler(msg as never)).catch((err) =>
          this.warn(`notification handler for ${msg.method} threw: ${formatErr(err)}`),
        );
      } catch (err) {
        this.warn(
          `notification handler for ${msg.method} threw synchronously: ${formatErr(err)}`,
        );
      }
    }
  }

  private unwrapJsonRpcResult<T>(
    msg: JsonRpcMessage,
    expectedId: number | string,
  ): T {
    if ("error" in msg) {
      const err = msg.error;
      const error: Error & { code?: number; data?: unknown } = new Error(
        err.message ?? "JSON-RPC error",
      );
      error.code = err.code;
      error.data = err.data;
      throw error;
    }
    if (!("result" in msg)) {
      throw new Error(
        "StatelessMcpHttpPreviewClient: response is neither result nor error",
      );
    }
    if ((msg as { id?: unknown }).id !== expectedId) {
      throw new Error(
        `StatelessMcpHttpPreviewClient: response id mismatch (got ${(msg as { id?: unknown }).id}, expected ${expectedId})`,
      );
    }
    return msg.result as T;
  }

  private async buildHeaders(
    method: string,
    opts: SendOptions,
    overrideAccessToken?: string,
  ): Promise<Record<string, string>> {
    const out: Record<string, string> = {
      ...this.staticHeaders,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      [MCP_PROTOCOL_VERSION_HEADER]: this.protocolVersion,
      [MCP_METHOD_HEADER]: method,
    };
    if (
      opts.nameHeader !== undefined &&
      METHODS_REQUIRING_NAME_HEADER.has(method)
    ) {
      out[MCP_NAME_HEADER] = opts.nameHeader;
    }
    if (opts.extraHeaders) {
      for (const [k, v] of Object.entries(opts.extraHeaders)) {
        out[k] = v;
      }
    }
    const token = overrideAccessToken ?? (await this.getAccessToken?.());
    if (token) out["Authorization"] = `Bearer ${token}`;
    return out;
  }

  private warn(message: string): void {
    // RpcLogger has no dedicated warning channel; emit as a synthetic
    // "receive" event with a wrapper object so the rpcLogger sees it.
    // Falls back to console.warn when no logger is wired so dev users
    // see something during testing.
    if (this.rpcLogger) {
      this.rpcLogger({
        direction: "receive",
        message: {
          jsonrpc: "2.0",
          method: "$/preview.warn",
          params: { message },
        },
        serverId: this.serverId,
      });
      return;
    }
    // eslint-disable-next-line no-console
    console.warn(`[stateless-mcp:${this.serverId}] ${message}`);
  }

  /** Test hook: lets unit tests assert non-conformance was recorded. */
  hasSeenNonConformingSessionId(): boolean {
    return this.nonConformingSessionIdSeen;
  }
}

function parseSingleMessage(text: string): JsonRpcMessage {
  const parsed = JSON.parse(text);
  if (parsed && typeof parsed === "object") return parsed as JsonRpcMessage;
  throw new Error(
    `StatelessMcpHttpPreviewClient: expected JSON-RPC object, got ${typeof parsed}`,
  );
}

function extractSseDataPayload(frame: string): string | undefined {
  // Concatenate all `data:` lines; skip `event:` / `id:` / `retry:` /
  // comment lines. Per the SSE spec, a single `data:` payload is the
  // concatenation of every `data:` line in the frame joined with `\n`.
  const dataLines: string[] = [];
  for (const rawLine of frame.split("\n")) {
    if (rawLine.startsWith(":")) continue;
    if (!rawLine.startsWith("data:")) continue;
    let line = rawLine.slice(5);
    if (line.startsWith(" ")) line = line.slice(1);
    dataLines.push(line);
  }
  if (dataLines.length === 0) return undefined;
  return dataLines.join("\n");
}

function extractTtlMs(result: unknown): number | undefined {
  if (!result || typeof result !== "object") return undefined;
  const ttl = (result as { ttlMs?: unknown }).ttlMs;
  if (typeof ttl === "number" && Number.isFinite(ttl)) return ttl;
  return undefined;
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
