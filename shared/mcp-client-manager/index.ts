import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ClientOptions } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { SSEClientTransportOptions } from '@modelcontextprotocol/sdk/client/sse.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { StreamableHTTPClientTransportOptions } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolResultSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  PromptListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
type ClientCapabilityOptions = NonNullable<ClientOptions['capabilities']>;

type BaseServerConfig = {
  capabilities?: ClientCapabilityOptions;
  timeout?: number;
  version?: string;
  onError?: (error: unknown) => void;
};

type StdioServerConfig = BaseServerConfig & {
  command: string;
  args?: string[];
  env?: Record<string, string>;

  url?: never;
  requestInit?: never;
  eventSourceInit?: never;
  authProvider?: never;
  reconnectionOptions?: never;
  sessionId?: never;
  preferSSE?: never;
};

type HttpServerConfig = BaseServerConfig & {
  url: URL;
  requestInit?: StreamableHTTPClientTransportOptions['requestInit'];
  eventSourceInit?: SSEClientTransportOptions['eventSourceInit'];
  authProvider?: StreamableHTTPClientTransportOptions['authProvider'];
  reconnectionOptions?: StreamableHTTPClientTransportOptions['reconnectionOptions'];
  sessionId?: StreamableHTTPClientTransportOptions['sessionId'];
  preferSSE?: boolean;

  command?: never;
  args?: never;
  env?: never;
};

export type MCPServerConfig = StdioServerConfig | HttpServerConfig;

export type MCPClientManagerConfig = Record<string, MCPServerConfig>;

type NotificationSchema = Parameters<Client['setNotificationHandler']>[0];
type NotificationHandler = Parameters<Client['setNotificationHandler']>[1];

interface NotificationHandlerEntry {
  schema: NotificationSchema;
  handler: NotificationHandler;
}

interface ManagedClientState {
  config: MCPServerConfig;
  client?: Client;
  transport?: Transport;
  connectionPromise?: Promise<Client>;
  timeout: number;
}

type ClientRequestOptions = RequestOptions;
type CallToolOptions = RequestOptions;

type ListResourcesParams = Parameters<Client['listResources']>[0];
type ListResourceTemplatesParams = Parameters<Client['listResourceTemplates']>[0];
type ReadResourceParams = Parameters<Client['readResource']>[0];
type SubscribeResourceParams = Parameters<Client['subscribeResource']>[0];
type UnsubscribeResourceParams = Parameters<Client['unsubscribeResource']>[0];
type ListPromptsParams = Parameters<Client['listPrompts']>[0];
type GetPromptParams = Parameters<Client['getPrompt']>[0];

export type ExecuteToolArguments = Record<string, unknown>;

export class MCPClientManager {
  private readonly serverConfigs = new Map<string, MCPServerConfig>();
  private readonly clientStates = new Map<string, ManagedClientState>();
  private readonly notificationHandlers = new Map<string, NotificationHandlerEntry[]>();
  private readonly defaultClientVersion: string;
  private readonly defaultCapabilities: ClientCapabilityOptions;
  private readonly defaultTimeout: number;

  constructor(
    servers: MCPClientManagerConfig = {},
    options: {
      defaultClientVersion?: string;
      defaultCapabilities?: ClientCapabilityOptions;
      defaultTimeout?: number;
    } = {},
  ) {
    this.defaultClientVersion = options.defaultClientVersion ?? '1.0.0';
    this.defaultCapabilities = { ...(options.defaultCapabilities ?? {}) };
    this.defaultTimeout = options.defaultTimeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC;

    for (const [name, config] of Object.entries(servers)) {
      this.registerServer(name, config);
    }
  }

  registerServer(name: string, config: MCPServerConfig): void {
    const serverName = name.trim();
    if (!serverName) {
      throw new Error('Server name must be a non-empty string.');
    }

    const state = this.clientStates.get(serverName);
    if (state?.connectionPromise) {
      throw new Error(`Server "${serverName}" is currently connecting. Disconnect before reconfiguring.`);
    }
    if (state?.client) {
      throw new Error(`Server "${serverName}" is already connected. Disconnect before reconfiguring.`);
    }

    this.serverConfigs.set(serverName, config);
    this.clientStates.set(serverName, {
      config,
      timeout: this.getTimeout(config),
    });
  }

  unregisterServer(name: string): void {
    const serverName = name.trim();
    const state = this.clientStates.get(serverName);
    if (state?.client || state?.connectionPromise) {
      throw new Error(`Cannot unregister server "${serverName}" while it is connected. Disconnect first.`);
    }

    this.serverConfigs.delete(serverName);
    this.clientStates.delete(serverName);
    this.notificationHandlers.delete(serverName);
  }

  listServers(): string[] {
    return Array.from(this.serverConfigs.keys());
  }

  hasServer(name: string): boolean {
    return this.serverConfigs.has(name.trim());
  }

  async connectToServer(name: string): Promise<Client> {
    const serverName = name.trim();
    const config = this.getServerConfig(serverName);
    const state = this.ensureState(serverName, config);

    if (state.client) {
      return state.client;
    }

    if (state.connectionPromise) {
      return state.connectionPromise;
    }

    const connectionPromise = this.createClientAndConnect(serverName, config)
      .then(client => {
        const updatedState = this.clientStates.get(serverName);
        if (!updatedState) {
          return client;
        }

        updatedState.client = client;
        updatedState.connectionPromise = undefined;
        updatedState.timeout = this.getTimeout(config);
        return client;
      })
      .catch(error => {
        this.resetState(serverName, { preserveConfig: true });
        throw error;
      });

    state.connectionPromise = connectionPromise;
    this.clientStates.set(serverName, state);
    return connectionPromise;
  }

  async disconnectServer(name: string): Promise<void> {
    const serverName = name.trim();
    const state = this.clientStates.get(serverName);

    if (!state?.client) {
      state?.connectionPromise?.catch(() => undefined);
      state ? (state.connectionPromise = undefined) : undefined;
      return;
    }

    try {
      await state.client.close();
      await state.transport?.close();
    } finally {
      this.resetState(serverName, { preserveConfig: true });
    }
  }

  async disconnectAll(): Promise<void> {
    await Promise.all(this.listServers().map(name => this.disconnectServer(name)));
  }

  async listTools(name: string, params?: Parameters<Client['listTools']>[0], options?: ClientRequestOptions) {
    const client = await this.connectToServer(name);
    return client.listTools(params, this.withTimeout(name, options));
  }

  async executeTool(name: string, toolName: string, args: ExecuteToolArguments = {}, options?: CallToolOptions) {
    const client = await this.connectToServer(name);
    return client.callTool(
      {
        name: toolName,
        arguments: args,
      },
      CallToolResultSchema,
      this.withTimeout(name, options),
    );
  }

  async listResources(name: string, params?: ListResourcesParams, options?: ClientRequestOptions) {
    const client = await this.connectToServer(name);
    return client.listResources(params, this.withTimeout(name, options));
  }

  async readResource(name: string, params: ReadResourceParams, options?: ClientRequestOptions) {
    const client = await this.connectToServer(name);
    return client.readResource(params, this.withTimeout(name, options));
  }

  async subscribeResource(name: string, params: SubscribeResourceParams, options?: ClientRequestOptions) {
    const client = await this.connectToServer(name);
    return client.subscribeResource(params, this.withTimeout(name, options));
  }

  async unsubscribeResource(name: string, params: UnsubscribeResourceParams, options?: ClientRequestOptions) {
    const client = await this.connectToServer(name);
    return client.unsubscribeResource(params, this.withTimeout(name, options));
  }

  async listResourceTemplates(name: string, params?: ListResourceTemplatesParams, options?: ClientRequestOptions) {
    const client = await this.connectToServer(name);
    return client.listResourceTemplates(params, this.withTimeout(name, options));
  }

  async listPrompts(name: string, params?: ListPromptsParams, options?: ClientRequestOptions) {
    const client = await this.connectToServer(name);
    return client.listPrompts(params, this.withTimeout(name, options));
  }

  async getPrompt(name: string, params: GetPromptParams, options?: ClientRequestOptions) {
    const client = await this.connectToServer(name);
    return client.getPrompt(params, this.withTimeout(name, options));
  }

  getSessionId(name: string): string | undefined {
    const state = this.clientStates.get(name.trim());
    if (!state?.transport) {
      return undefined;
    }
    if (state.transport instanceof StreamableHTTPClientTransport) {
      return state.transport.sessionId;
    }
    return undefined;
  }

  addNotificationHandler(name: string, schema: NotificationSchema, handler: NotificationHandler): void {
    const serverName = name.trim();
    const handlers = this.notificationHandlers.get(serverName) ?? [];
    handlers.push({ schema, handler });
    this.notificationHandlers.set(serverName, handlers);

    const client = this.clientStates.get(serverName)?.client;
    if (client) {
      client.setNotificationHandler(schema, handler);
    }
  }

  onResourceListChanged(name: string, handler: NotificationHandler): void {
    this.addNotificationHandler(name, ResourceListChangedNotificationSchema, handler);
  }

  onResourceUpdated(name: string, handler: NotificationHandler): void {
    this.addNotificationHandler(name, ResourceUpdatedNotificationSchema, handler);
  }

  onPromptListChanged(name: string, handler: NotificationHandler): void {
    this.addNotificationHandler(name, PromptListChangedNotificationSchema, handler);
  }

  getClient(name: string): Client | undefined {
    return this.clientStates.get(name.trim())?.client;
  }

  private async createClientAndConnect(serverName: string, config: MCPServerConfig): Promise<Client> {
    const capabilities = this.buildCapabilities(config);

    const client = new Client(
      {
        name: serverName,
        version: config.version ?? this.defaultClientVersion,
      },
      {
        capabilities,
      },
    );

    this.applyNotificationHandlers(serverName, client);

    if (config.onError) {
      client.onerror = error => {
        config.onError?.(error);
      };
    }

    client.onclose = () => {
      this.resetState(serverName, { preserveConfig: true });
    };

    const timeout = this.getTimeout(config);

    if (this.isStdioConfig(config)) {
      const transport = await this.connectViaStdio(client, config, timeout);
      this.setTransport(serverName, transport);
      return client;
    }

    const transport = await this.connectViaHttp(serverName, client, config, timeout);
    this.setTransport(serverName, transport);
    return client;
  }

  private async connectViaStdio(client: Client, config: StdioServerConfig, timeout: number): Promise<Transport> {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
    });
    await client.connect(transport, { timeout });
    return transport;
  }

  private async connectViaHttp(serverName: string, client: Client, config: HttpServerConfig, timeout: number): Promise<Transport> {
    const preferSSE = config.preferSSE ?? config.url.pathname.endsWith('/sse');
    let streamableError: unknown;

    if (!preferSSE) {
      const streamableTransport = new StreamableHTTPClientTransport(config.url, {
        requestInit: config.requestInit,
        reconnectionOptions: config.reconnectionOptions,
        authProvider: config.authProvider,
        sessionId: config.sessionId,
      });

      try {
        await client.connect(streamableTransport, { timeout: Math.min(timeout, 3000) });
        return streamableTransport;
      } catch (error) {
        streamableError = error;
        await this.safeCloseTransport(streamableTransport);
      }
    }

    const sseTransport = new SSEClientTransport(config.url, {
      requestInit: config.requestInit,
      eventSourceInit: config.eventSourceInit,
      authProvider: config.authProvider,
    });

    try {
      await client.connect(sseTransport, { timeout });
      return sseTransport;
    } catch (error) {
      await this.safeCloseTransport(sseTransport);
      const streamableMessage = streamableError
        ? ` Streamable HTTP error: ${this.formatError(streamableError)}.`
        : '';
      throw new Error(
        `Failed to connect to MCP server "${serverName}" using HTTP transports.${streamableMessage} SSE error: ${this.formatError(error)}.`,
      );
    }
  }

  private async safeCloseTransport(transport: Transport): Promise<void> {
    try {
      await transport.close();
    } catch {
      // Ignore close errors during cleanup.
    }
  }

  private applyNotificationHandlers(serverName: string, client: Client): void {
    const handlers = this.notificationHandlers.get(serverName);
    if (!handlers) {
      return;
    }

    for (const { schema, handler } of handlers) {
      client.setNotificationHandler(schema, handler);
    }
  }

  private ensureState(name: string, config: MCPServerConfig): ManagedClientState {
    const existing = this.clientStates.get(name);
    if (existing) {
      existing.config = config;
      existing.timeout = this.getTimeout(config);
      return existing;
    }

    const state: ManagedClientState = {
      config,
      timeout: this.getTimeout(config),
    };
    this.clientStates.set(name, state);
    return state;
  }

  private resetState(name: string, options: { preserveConfig: boolean }): void {
    const state = this.clientStates.get(name);
    if (!state) {
      return;
    }

    if (!options.preserveConfig) {
      this.clientStates.delete(name);
      return;
    }

    state.client = undefined;
    state.transport = undefined;
    state.connectionPromise = undefined;
  }

  private setTransport(name: string, transport: Transport): void {
    const state = this.clientStates.get(name);
    if (!state) {
      return;
    }
    state.transport = transport;
  }

  private withTimeout(name: string, options?: RequestOptions): RequestOptions {
    const timeout = this.clientStates.get(name.trim())?.timeout ?? this.defaultTimeout;

    if (!options) {
      return { timeout };
    }

    if (options.timeout === undefined) {
      return { ...options, timeout };
    }

    return options;
  }

  private getServerConfig(name: string): MCPServerConfig {
    const config = this.serverConfigs.get(name);
    if (!config) {
      throw new Error(`Unknown MCP server "${name}".`);
    }
    return config;
  }

  private buildCapabilities(config: MCPServerConfig): ClientCapabilityOptions {
    const capabilities: ClientCapabilityOptions = {
      ...this.defaultCapabilities,
      ...(config.capabilities ?? {}),
    };

    if (!capabilities.elicitation) {
      capabilities.elicitation = {};
    }

    return capabilities;
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  private getTimeout(config: MCPServerConfig): number {
    return config.timeout ?? this.defaultTimeout;
  }

  private isStdioConfig(config: MCPServerConfig): config is StdioServerConfig {
    return 'command' in config;
  }

}
