/**
 * `LogLevelMetaClient` — a `ManagedMcpClient` decorator that injects the
 * modern per-request logging opt-in into outbound requests.
 *
 * MCPJam keeps ONE user-facing logging concept ("set a level for this
 * server") with era-specific delivery:
 *
 *   - **Legacy (2025-era):** the level is delivered once via
 *     `logging/setLevel` on connect (the manager's existing
 *     `setLoggingLevel` + auto-`debug` gate). This decorator is inert.
 *
 *   - **Modern (2026-07-28):** there is no session to carry a level, so the
 *     level rides along on EVERY request as a `_meta` key
 *     (`LOG_LEVEL_META_KEY = "io.modelcontextprotocol/logLevel"`). Upstream
 *     `Client` exports the key but its outbound-meta envelope never supplies
 *     a value, so this decorator merges it into `params._meta`.
 *
 * The injection is applied ONLY WHEN both hold:
 *   (a) a level is currently set for this server (`getLevel()` is defined), and
 *   (b) the negotiated connection era is `"modern"`.
 *
 * When no level is set the `_meta` key is ABSENT — absence is semantic here
 * (opt-out), so we never send an empty/null key. Caller-supplied `_meta` keys
 * always win: the level is spread first and the caller's `_meta` spread on top.
 */

import {
  LOG_LEVEL_META_KEY,
  type CacheableRequestOptions,
  type LoggingLevel,
  type ProtocolEra,
  type Request,
  type RequestOptions,
} from "@modelcontextprotocol/client";
import type {
  ManagedMcpClient,
  ManagedMcpClientConnectOptions,
  ManagedMcpClientNotificationHandler,
  ManagedMcpClientNotificationMethod,
  ManagedMcpClientRequestHandler,
  ManagedMcpClientRequestMethod,
} from "./managed-mcp-client.js";

/**
 * Live accessor for the per-server request log level. Returning `undefined`
 * means "opt-out": no `_meta` key is injected. Read fresh on every call so a
 * `setPerRequestLogLevel` change takes effect immediately without reconnect.
 */
export type LogLevelProvider = () => LoggingLevel | undefined;

export class LogLevelMetaClient implements ManagedMcpClient {
  constructor(
    readonly inner: ManagedMcpClient,
    private readonly getLevel: LogLevelProvider,
  ) {}

  /**
   * The level to inject on this call, or `undefined` to inject nothing.
   * `undefined` when no level is set (opt-out) OR the era is not modern
   * (legacy delivers via `logging/setLevel`, so injecting `_meta` would be a
   * second, redundant channel).
   */
  private activeLevel(): LoggingLevel | undefined {
    const level = this.getLevel();
    if (level === undefined) {
      return undefined;
    }
    if (this.inner.getProtocolEra?.() !== "modern") {
      return undefined;
    }
    return level;
  }

  /**
   * Merge the active level into `params._meta` under `LOG_LEVEL_META_KEY`.
   * Caller `_meta` keys win (spread last). Returns `params` untouched when
   * there is nothing to inject.
   */
  private inject<T extends Record<string, unknown> | undefined>(params: T): T {
    const level = this.activeLevel();
    if (level === undefined) {
      return params;
    }
    const callerMeta = (params as { _meta?: Record<string, unknown> } | undefined)
      ?._meta;
    return {
      ...(params ?? {}),
      _meta: { [LOG_LEVEL_META_KEY]: level, ...(callerMeta ?? {}) },
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

  // ---- Request-bearing methods (inject `_meta` when modern + level set) ----
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
    const level = this.activeLevel();
    if (level === undefined) {
      return this.inner.request<T>(req, options);
    }
    const params = this.inject(
      req.params as Record<string, unknown> | undefined,
    );
    return this.inner.request<T>({ ...req, params } as Request, options);
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
    // Legacy delivery channel — always forwarded verbatim, never gated.
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
