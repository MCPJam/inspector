/**
 * `TraceContextMetaClient` — a `ManagedMcpClient` decorator that propagates an
 * ambient OpenTelemetry trace context into outbound requests.
 *
 * The 2026-07-28 spec reserves `traceparent`, `tracestate`, and `baggage` in
 * `_meta` as an exception to the prefix rule, and requires only that their
 * VALUES follow W3C Trace Context / W3C Baggage when present. Sending them is
 * a documented convention, not a MUST, so this decorator only ever
 * PROPAGATES: it never mints a trace id or span id to fill the field.
 *
 * The injection is applied ONLY WHEN both hold:
 *   (a) the provider returns a context for this server, and
 *   (b) the negotiated connection era is `"modern"`.
 *
 * (b) is what keeps legacy (2025-era) wire output byte-identical: these keys
 * are a 2026-07-28 convention, and a 2025 server has no reason to receive
 * them.
 *
 * MCPJam itself supplies NO provider — we do not run an OpenTelemetry tracer
 * — so by default the keys are ABSENT, which is the honest answer: absence is
 * semantic in MCP, and a fabricated span would be worse than no span. A
 * provider that returns a malformed value is likewise treated as no context;
 * see `trace-context.ts` for the validation and for why `baggage` must never
 * reach an analytics payload.
 *
 * Caller-supplied `_meta` keys always win: the trace keys are spread first
 * and the caller's `_meta` spread on top.
 */

import type {
  CacheableRequestOptions,
  ProtocolEra,
  Request,
  RequestOptions,
  StandardSchemaV1,
  LoggingLevel,
} from "@modelcontextprotocol/client";
import type {
  ManagedMcpClient,
  ManagedMcpClientConnectOptions,
  ManagedMcpClientNotificationHandler,
  ManagedMcpClientNotificationMethod,
  ManagedMcpClientRequestHandler,
  ManagedMcpClientRequestMethod,
} from "./managed-mcp-client.js";
import {
  sanitizeTraceContext,
  traceContextToMeta,
  type TraceContext,
} from "./trace-context.js";

/**
 * Live accessor for this connection's ambient trace context, already bound to
 * a server id by the factory. Returning `undefined` means "no trace": no
 * `_meta` keys are injected. Read fresh on every call so a caller whose
 * tracer changes spans per operation propagates the current one without
 * reconnecting.
 */
export type ConnectionTraceContextProvider = () => TraceContext | undefined;

export class TraceContextMetaClient implements ManagedMcpClient {
  /**
   * `server/discover` pass-through — bound only when the inner client
   * carries it, so absence propagates through the decorator stack and
   * `MCPClientManager.pingServer` can fall back to `ping` instead of
   * seeing a probe that "succeeds" with no wire traffic. No trace-context
   * injection (upstream stamps the discover envelope itself).
   */
  readonly discover?: (options?: RequestOptions) => Promise<unknown>;

  constructor(
    readonly inner: ManagedMcpClient,
    private readonly getTraceContext: ConnectionTraceContextProvider,
  ) {
    if (inner.discover) {
      this.discover = inner.discover.bind(inner);
    }
  }

  /**
   * The context to inject on this call, or `undefined` to inject nothing.
   * `undefined` when the provider has no context, when the value it returned
   * is malformed (we drop rather than forward — the spec's MUST is about the
   * value), or when the era is not modern.
   */
  private activeContext(): TraceContext | undefined {
    const context = sanitizeTraceContext(this.getTraceContext());
    if (context === undefined) {
      return undefined;
    }
    if (this.inner.getProtocolEra?.() !== "modern") {
      return undefined;
    }
    return context;
  }

  /**
   * Merge the active trace context into `params._meta`. Caller `_meta` keys
   * win (spread last). Returns `params` untouched when there is nothing to
   * inject.
   */
  private inject<T extends Record<string, unknown> | undefined>(params: T): T {
    const context = this.activeContext();
    if (context === undefined) {
      return params;
    }
    const callerMeta = (params as { _meta?: Record<string, unknown> } | undefined)
      ?._meta;
    return {
      ...(params ?? {}),
      _meta: { ...traceContextToMeta(context), ...(callerMeta ?? {}) },
    } as unknown as T;
  }

  // ---- Lifecycle (pass-through) ----
  connect(
    transport: Parameters<ManagedMcpClient["connect"]>[0],
    options?: ManagedMcpClientConnectOptions,
  ): Promise<void> {
    return this.inner.connect(transport, options);
  }
  close(): Promise<void> {
    return this.inner.close();
  }
  get onerror(): ((error: Error) => void) | undefined {
    return this.inner.onerror;
  }
  set onerror(handler: ((error: Error) => void) | undefined) {
    this.inner.onerror = handler;
  }
  get onclose(): (() => void) | undefined {
    return this.inner.onclose;
  }
  set onclose(handler: (() => void) | undefined) {
    this.inner.onclose = handler;
  }

  // ---- Capability / identity getters (pass-through) ----
  getServerCapabilities() {
    return this.inner.getServerCapabilities();
  }
  getServerVersion() {
    return this.inner.getServerVersion();
  }
  getInstructions() {
    return this.inner.getInstructions();
  }
  getProtocolEra(): ProtocolEra | undefined {
    return this.inner.getProtocolEra?.();
  }
  getNegotiatedProtocolVersion(): string | undefined {
    return this.inner.getNegotiatedProtocolVersion?.();
  }

  // ---- Request-bearing methods (inject `_meta` when modern + context) ----
  listTools(
    params?: Parameters<ManagedMcpClient["listTools"]>[0],
    options?: CacheableRequestOptions,
  ) {
    return this.inner.listTools(this.inject(params), options);
  }
  callTool(
    params: Parameters<ManagedMcpClient["callTool"]>[0],
    options?: RequestOptions,
  ) {
    return this.inner.callTool(this.inject(params), options);
  }
  request<T = unknown>(req: Request, options?: RequestOptions): Promise<T> {
    const context = this.activeContext();
    if (context === undefined) {
      return this.inner.request<T>(req, options);
    }
    const params = this.inject(
      req.params as Record<string, unknown> | undefined,
    );
    return this.inner.request<T>({ ...req, params } as Request, options);
  }
  requestWithSchema<TSchema extends StandardSchemaV1>(
    req: Request,
    resultSchema: TSchema,
    options?: RequestOptions,
  ): Promise<StandardSchemaV1.InferOutput<TSchema>> {
    // Same propagation as `request`. The explicit-schema seam MUST carry it or
    // the MRTR retry legs would leave their trace, making a multi-round-trip
    // call look like two unrelated traces on the server side.
    const context = this.activeContext();
    if (context === undefined) {
      return this.inner.requestWithSchema(req, resultSchema, options);
    }
    const params = this.inject(
      req.params as Record<string, unknown> | undefined,
    );
    return this.inner.requestWithSchema(
      { ...req, params } as Request,
      resultSchema,
      options,
    );
  }
  listResources(
    params?: Parameters<ManagedMcpClient["listResources"]>[0],
    options?: CacheableRequestOptions,
  ) {
    return this.inner.listResources(this.inject(params), options);
  }
  readResource(
    params: Parameters<ManagedMcpClient["readResource"]>[0],
    options?: CacheableRequestOptions,
  ) {
    return this.inner.readResource(this.inject(params), options);
  }
  listResourceTemplates(
    params?: Parameters<ManagedMcpClient["listResourceTemplates"]>[0],
    options?: CacheableRequestOptions,
  ) {
    return this.inner.listResourceTemplates(this.inject(params), options);
  }
  listPrompts(
    params?: Parameters<ManagedMcpClient["listPrompts"]>[0],
    options?: CacheableRequestOptions,
  ) {
    return this.inner.listPrompts(this.inject(params), options);
  }
  getPrompt(
    params: Parameters<ManagedMcpClient["getPrompt"]>[0],
    options?: RequestOptions,
  ) {
    return this.inner.getPrompt(this.inject(params), options);
  }
  subscribeResource(
    params: Parameters<ManagedMcpClient["subscribeResource"]>[0],
    options?: RequestOptions,
  ) {
    return this.inner.subscribeResource(this.inject(params), options);
  }
  unsubscribeResource(
    params: Parameters<ManagedMcpClient["unsubscribeResource"]>[0],
    options?: RequestOptions,
  ) {
    return this.inner.unsubscribeResource(this.inject(params), options);
  }

  listen(
    filter: Parameters<NonNullable<ManagedMcpClient["listen"]>>[0],
    options?: RequestOptions,
  ) {
    // Long-lived stream, not a request leg: pinning it to whichever span
    // happened to be current when the stream opened would attribute every
    // later notification to that one span, so this forwards verbatim.
    const inner = this.inner.listen?.bind(this.inner);
    if (!inner) {
      throw new Error(
        "The wrapped client does not implement subscriptions/listen.",
      );
    }
    return inner(filter, options);
  }

  complete(
    params: Parameters<ManagedMcpClient["complete"]>[0],
    options?: RequestOptions,
  ) {
    return this.inner.complete(this.inject(params), options);
  }

  // ---- No-params / non-injected methods (pass-through) ----
  ping(options?: RequestOptions) {
    return this.inner.ping(options);
  }
  setLoggingLevel(level: LoggingLevel, options?: RequestOptions): Promise<void> {
    // Legacy-era delivery channel — never carries modern `_meta`.
    return this.inner.setLoggingLevel(level, options);
  }

  // ---- Handler registration (pass-through) ----
  setNotificationHandler(
    method: ManagedMcpClientNotificationMethod,
    handler: ManagedMcpClientNotificationHandler,
  ): void {
    this.inner.setNotificationHandler(method, handler);
  }
  setRequestHandler(
    method: ManagedMcpClientRequestMethod,
    handler: ManagedMcpClientRequestHandler,
  ): void {
    this.inner.setRequestHandler(method, handler);
  }
  removeRequestHandler(method: ManagedMcpClientRequestMethod): void {
    this.inner.removeRequestHandler(method);
  }
}
