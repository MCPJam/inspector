/**
 * `OfficialSdkClientAdapter` — passthrough wrapper around upstream
 * `@modelcontextprotocol/client@2.0.0-alpha.2` `Client`. Used when the
 * resolved `mcpProtocolVersion` is absent or stateful (per
 * `isStatelessProtocolVersion`). Behavior is byte-identical to direct
 * upstream usage; this wrapper exists only so `MCPClientManager` can
 * type its client state as `ManagedMcpClient` and the
 * `StatelessMcpHttpPreviewClient` can slot in via the same factory.
 *
 * **No translation, no defaults.** Every method forwards arguments
 * verbatim — translating would silently change behavior on edge cases
 * (e.g. progress handler currying, zod schema `.passthrough()`,
 * `RequestOptions.maxTotalTimeout` reset semantics).
 *
 * `onerror` / `onclose` are forwarded through getters/setters so the
 * manager's existing `client.onclose = () => ...` pattern keeps working
 * without ever holding a reference to the wrapper instead of the
 * underlying Client.
 */

import type { Client } from "@modelcontextprotocol/client";
import type {
  ManagedMcpClient,
  ManagedMcpClientConnectOptions,
  ManagedMcpClientNotificationHandler,
  ManagedMcpClientNotificationMethod,
  ManagedMcpClientRequestHandler,
  ManagedMcpClientRequestMethod,
} from "./managed-mcp-client.js";

export class OfficialSdkClientAdapter implements ManagedMcpClient {
  readonly inner: Client;

  constructor(client: Client) {
    this.inner = client;
  }

  // ---- Lifecycle ----
  connect(
    transport: Parameters<Client["connect"]>[0],
    options?: ManagedMcpClientConnectOptions,
  ): Promise<void> {
    // Upstream `Client.connect` accepts `RequestOptions`. Our
    // `ManagedMcpClientConnectOptions` is a strict subset; widen at the
    // boundary rather than re-shape the manager call site.
    return this.inner.connect(transport, options as never);
  }
  close(): Promise<void> {
    return this.inner.close();
  }
  get onerror(): ((error: Error) => void) | undefined {
    return this.inner.onerror;
  }
  set onerror(handler: ((error: Error) => void) | undefined) {
    this.inner.onerror = handler as never;
  }
  get onclose(): (() => void) | undefined {
    return this.inner.onclose;
  }
  set onclose(handler: (() => void) | undefined) {
    this.inner.onclose = handler as never;
  }

  // ---- Capability / identity getters ----
  getServerCapabilities() {
    return this.inner.getServerCapabilities();
  }
  getServerVersion() {
    return this.inner.getServerVersion();
  }
  getInstructions() {
    return this.inner.getInstructions();
  }

  // ---- RPC ----
  listTools(
    params?: Parameters<Client["listTools"]>[0],
    options?: Parameters<Client["listTools"]>[1],
  ) {
    return this.inner.listTools(params, options) as ReturnType<
      ManagedMcpClient["listTools"]
    >;
  }
  callTool(
    params: Parameters<Client["callTool"]>[0],
    options?: Parameters<Client["callTool"]>[1],
  ) {
    return this.inner.callTool(params, options) as ReturnType<
      ManagedMcpClient["callTool"]
    >;
  }
  request<T = unknown>(
    req: Parameters<Client["request"]>[0],
    options?: Parameters<Client["request"]>[1],
  ): Promise<T> {
    // upstream `Client.request` is method-dispatched and typed against
    // RequestTypeMap. We're a generic boundary; the caller has already
    // narrowed to a method literal it understands.
    return this.inner.request(req as never, options) as Promise<T>;
  }
  listResources(
    params?: Parameters<Client["listResources"]>[0],
    options?: Parameters<Client["listResources"]>[1],
  ) {
    return this.inner.listResources(params, options) as ReturnType<
      ManagedMcpClient["listResources"]
    >;
  }
  readResource(
    params: Parameters<Client["readResource"]>[0],
    options?: Parameters<Client["readResource"]>[1],
  ) {
    return this.inner.readResource(params, options) as ReturnType<
      ManagedMcpClient["readResource"]
    >;
  }
  listResourceTemplates(
    params?: Parameters<Client["listResourceTemplates"]>[0],
    options?: Parameters<Client["listResourceTemplates"]>[1],
  ) {
    return this.inner.listResourceTemplates(params, options) as ReturnType<
      ManagedMcpClient["listResourceTemplates"]
    >;
  }
  listPrompts(
    params?: Parameters<Client["listPrompts"]>[0],
    options?: Parameters<Client["listPrompts"]>[1],
  ) {
    return this.inner.listPrompts(params, options) as ReturnType<
      ManagedMcpClient["listPrompts"]
    >;
  }
  getPrompt(
    params: Parameters<Client["getPrompt"]>[0],
    options?: Parameters<Client["getPrompt"]>[1],
  ) {
    return this.inner.getPrompt(params, options) as ReturnType<
      ManagedMcpClient["getPrompt"]
    >;
  }
  ping(options?: Parameters<Client["ping"]>[0]) {
    return this.inner.ping(options) as ReturnType<ManagedMcpClient["ping"]>;
  }
  subscribeResource(
    params: Parameters<Client["subscribeResource"]>[0],
    options?: Parameters<Client["subscribeResource"]>[1],
  ) {
    return this.inner.subscribeResource(params, options) as ReturnType<
      ManagedMcpClient["subscribeResource"]
    >;
  }
  unsubscribeResource(
    params: Parameters<Client["unsubscribeResource"]>[0],
    options?: Parameters<Client["unsubscribeResource"]>[1],
  ) {
    return this.inner.unsubscribeResource(params, options) as ReturnType<
      ManagedMcpClient["unsubscribeResource"]
    >;
  }
  async setLoggingLevel(
    level: Parameters<Client["setLoggingLevel"]>[0],
    options?: Parameters<Client["setLoggingLevel"]>[1],
  ): Promise<void> {
    // Upstream returns `EmptyResult`; manager doesn't use it. Discard so
    // adapter signatures stay aligned with the void interface contract.
    await this.inner.setLoggingLevel(level, options);
  }

  // ---- Handlers ----
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
