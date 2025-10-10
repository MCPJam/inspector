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
  ElicitRequestSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  PromptListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { ElicitRequest, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
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
  timeout: number;
  client?: Client;
  transport?: Transport;
  promise?: Promise<Client>;
}

// Pending state is tracked inside ManagedClientState.promise

type ClientRequestOptions = RequestOptions;
type CallToolOptions = RequestOptions;

type ListResourcesParams = Parameters<Client['listResources']>[0];
type ListResourceTemplatesParams = Parameters<Client['listResourceTemplates']>[0];
type ReadResourceParams = Parameters<Client['readResource']>[0];
type SubscribeResourceParams = Parameters<Client['subscribeResource']>[0];
type UnsubscribeResourceParams = Parameters<Client['unsubscribeResource']>[0];
type ListPromptsParams = Parameters<Client['listPrompts']>[0];
type GetPromptParams = Parameters<Client['getPrompt']>[0];
type ListToolsResult = Awaited<ReturnType<Client['listTools']>>;

export type ExecuteToolArguments = Record<string, unknown>;
export type ElicitationHandler = (
  params: ElicitRequest['params'],
) => Promise<ElicitResult> | ElicitResult;

export class MCPClientManager {
  private readonly clientStates = new Map<string, ManagedClientState>();
  private readonly notificationHandlers = new Map<string, Map<NotificationSchema, Set<NotificationHandler>>>();
  private readonly elicitationHandlers = new Map<string, ElicitationHandler>();
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
      void this.connectToServer(name, config);
    }
  }

  listServers(): string[] {
    return Array.from(this.clientStates.keys());
  }

  hasServer(name: string): boolean {
    const serverName = this.normalizeName(name);
    return this.clientStates.has(serverName);
  }

  async connectToServer(name: string, config: MCPServerConfig): Promise<Client> {
    const serverName = this.normalizeName(name);
    const timeout = this.getTimeout(config);
    const state = this.clientStates.get(serverName) ?? { config, timeout };
    // Update config/timeout on every call
    state.config = config;
    state.timeout = timeout;
    // If already connected, return the client
    if (state.client) {
      this.clientStates.set(serverName, state);
      return state.client;
    }
    // If connection is in-flight, reuse the promise
    if (state.promise) {
      this.clientStates.set(serverName, state);
      return state.promise;
    }

    const connectionPromise = (async () => {
      const client = new Client(
        {
          name: serverName,
          version: config.version ?? this.defaultClientVersion,
        },
        {
          capabilities: this.buildCapabilities(config),
        },
      );

      this.applyNotificationHandlers(serverName, client);
      this.applyElicitationHandler(serverName, client);

      if (config.onError) {
        client.onerror = error => {
          config.onError?.(error);
        };
      }

      client.onclose = () => {
        this.resetState(serverName);
      };

      let transport: Transport;
      if (this.isStdioConfig(config)) {
        transport = await this.connectViaStdio(client, config, timeout);
      } else {
        transport = await this.connectViaHttp(serverName, client, config, timeout);
      }

      state.client = client;
      state.transport = transport;
      // clear pending
      state.promise = undefined;
      this.clientStates.set(serverName, state);

      return client;
    })().catch(error => {
      // Clear pending but keep config so the server remains registered
      state.promise = undefined;
      state.client = undefined;
      state.transport = undefined;
      this.clientStates.set(serverName, state);
      throw error;
    });

    state.promise = connectionPromise;
    this.clientStates.set(serverName, state);
    return connectionPromise;
  }

  async disconnectServer(name: string): Promise<void> {
    const serverName = this.normalizeName(name);
    const client = this.getClientByName(serverName);
    try {
      await client.close();
    } finally {
      if (client.transport) {
        await this.safeCloseTransport(client.transport);
      }
      this.resetState(serverName);
    }
  }

  async disconnectAllServers(): Promise<void> {
    const serverNames = this.listServers();
    await Promise.all(serverNames.map(name => this.disconnectServer(name)));

    for (const name of serverNames) {
      const serverName = this.normalizeName(name);
      this.resetState(serverName);
      this.notificationHandlers.delete(serverName);
      this.elicitationHandlers.delete(serverName);
    }
  }

  async listTools(name: string, params?: Parameters<Client['listTools']>[0], options?: ClientRequestOptions) {
    const serverName = this.normalizeName(name);
    await this.ensureConnected(serverName);
    const client = this.getClientByName(serverName);
    return client.listTools(params, this.withTimeout(serverName, options));
  }

  async getTools(names?: string[]): Promise<ListToolsResult> {
    const targetNames = names && names.length > 0 ? names.map(name => this.normalizeName(name)) : this.listServers();
    const uniqueNames = Array.from(new Set(targetNames));

    const toolLists = await Promise.all(
      uniqueNames.map(async serverName => {
        await this.ensureConnected(serverName);
        const client = this.getClientByName(serverName);
        const result = await client.listTools(undefined, this.withTimeout(serverName));
        return result.tools;
      }),
    );

    return { tools: toolLists.flat() };
  }

  async executeTool(name: string, toolName: string, args: ExecuteToolArguments = {}, options?: CallToolOptions) {
    const serverName = this.normalizeName(name);
    await this.ensureConnected(serverName);
    const client = this.getClientByName(serverName);
    return client.callTool(
      {
        name: toolName,
        arguments: args,
      },
      CallToolResultSchema,
      this.withTimeout(serverName, options),
    );
  }

  async listResources(name: string, params?: ListResourcesParams, options?: ClientRequestOptions) {
    const serverName = this.normalizeName(name);
    await this.ensureConnected(serverName);
    const client = this.getClientByName(serverName);
    return client.listResources(params, this.withTimeout(serverName, options));
  }

  async readResource(name: string, params: ReadResourceParams, options?: ClientRequestOptions) {
    const serverName = this.normalizeName(name);
    await this.ensureConnected(serverName);
    const client = this.getClientByName(serverName);
    return client.readResource(params, this.withTimeout(serverName, options));
  }

  async subscribeResource(name: string, params: SubscribeResourceParams, options?: ClientRequestOptions) {
    const serverName = this.normalizeName(name);
    await this.ensureConnected(serverName);
    const client = this.getClientByName(serverName);
    return client.subscribeResource(params, this.withTimeout(serverName, options));
  }

  async unsubscribeResource(name: string, params: UnsubscribeResourceParams, options?: ClientRequestOptions) {
    const serverName = this.normalizeName(name);
    await this.ensureConnected(serverName);
    const client = this.getClientByName(serverName);
    return client.unsubscribeResource(params, this.withTimeout(serverName, options));
  }

  async listResourceTemplates(name: string, params?: ListResourceTemplatesParams, options?: ClientRequestOptions) {
    const serverName = this.normalizeName(name);
    await this.ensureConnected(serverName);
    const client = this.getClientByName(serverName);
    return client.listResourceTemplates(params, this.withTimeout(serverName, options));
  }

  async listPrompts(name: string, params?: ListPromptsParams, options?: ClientRequestOptions) {
    const serverName = this.normalizeName(name);
    await this.ensureConnected(serverName);
    const client = this.getClientByName(serverName);
    return client.listPrompts(params, this.withTimeout(serverName, options));
  }

  async getPrompt(name: string, params: GetPromptParams, options?: ClientRequestOptions) {
    const serverName = this.normalizeName(name);
    await this.ensureConnected(serverName);
    const client = this.getClientByName(serverName);
    return client.getPrompt(params, this.withTimeout(serverName, options));
  }

  getSessionIdByServer(name: string): string | undefined {
    const state = this.clientStates.get(this.normalizeName(name));
    if (!state?.transport) {
      throw new Error(`Unknown MCP server "${name}".`);
    }
    if (state.transport instanceof StreamableHTTPClientTransport) {
      return state.transport.sessionId;
    }
    throw new Error(`Server "${name}" must be Streamable HTTP to get the session ID.`);
  }

  addNotificationHandler(name: string, schema: NotificationSchema, handler: NotificationHandler): void {
    const serverName = this.normalizeName(name);
    const serverHandlers = this.notificationHandlers.get(serverName) ?? new Map();
    const handlersForSchema = serverHandlers.get(schema) ?? new Set<NotificationHandler>();
    handlersForSchema.add(handler);
    serverHandlers.set(schema, handlersForSchema);
    this.notificationHandlers.set(serverName, serverHandlers);

    const client = this.clientStates.get(serverName)?.client;
    if (client) {
      client.setNotificationHandler(schema, this.createNotificationDispatcher(serverName, schema));
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
    return this.clientStates.get(this.normalizeName(name))?.client;
  }

  setElicitationHandler(name: string, handler: ElicitationHandler): void {
    const serverName = this.normalizeName(name);
    if (!this.clientStates.has(serverName)) {
      throw new Error(`Unknown MCP server "${serverName}".`);
    }

    this.elicitationHandlers.set(serverName, handler);

    const client = this.clientStates.get(serverName)?.client;
    if (client) {
      this.applyElicitationHandler(serverName, client);
    }
  }

  clearElicitationHandler(name: string): void {
    const serverName = this.normalizeName(name);
    this.elicitationHandlers.delete(serverName);
    const client = this.clientStates.get(serverName)?.client;
    if (client) {
      client.removeRequestHandler('elicitation/create');
    }
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
    const serverHandlers = this.notificationHandlers.get(serverName);
    if (!serverHandlers) {
      return;
    }

    for (const [schema] of serverHandlers) {
      client.setNotificationHandler(schema, this.createNotificationDispatcher(serverName, schema));
    }
  }

  private createNotificationDispatcher(serverName: string, schema: NotificationSchema): NotificationHandler {
    return notification => {
      const serverHandlers = this.notificationHandlers.get(serverName);
      const handlersForSchema = serverHandlers?.get(schema);
      if (!handlersForSchema || handlersForSchema.size === 0) {
        return;
      }
      for (const handler of handlersForSchema) {
        try {
          handler(notification);
        } catch {
          // Swallow individual handler errors to avoid breaking other listeners.
        }
      }
    };
  }

  private applyElicitationHandler(serverName: string, client: Client): void {
    const handler = this.elicitationHandlers.get(serverName);
    if (!handler) {
      return;
    }

    client.setRequestHandler(ElicitRequestSchema, async request => handler(request.params));
  }

  private async ensureConnected(name: string): Promise<void> {
    const serverName = this.normalizeName(name);
    const state = this.clientStates.get(serverName);
    if (state?.client) {
      return;
    }

    if (!state) {
      throw new Error(`Unknown MCP server "${serverName}".`);
    }
    if (state.promise) {
      await state.promise;
      return;
    }
    await this.connectToServer(serverName, state.config);
  }

  private resetState(name: string): void {
    const serverName = this.normalizeName(name);
    this.clientStates.delete(serverName);
  }

  private withTimeout(name: string, options?: RequestOptions): RequestOptions {
    const serverName = this.normalizeName(name);
    const state = this.clientStates.get(serverName);
    const timeout = state?.timeout ?? (state ? this.getTimeout(state.config) : this.defaultTimeout);

    if (!options) {
      return { timeout };
    }

    if (options.timeout === undefined) {
      return { ...options, timeout };
    }

    return options;
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

  private normalizeName(name: string): string {
    const normalized = name.trim();
    if (!normalized) {
      throw new Error('Server name must be a non-empty string.');
    }
    return normalized;
  }

  private getClientByName(name: string): Client {
    const serverName = this.normalizeName(name);
    const state = this.clientStates.get(serverName);
    if (!state?.client) {
      throw new Error(`MCP server "${serverName}" is not connected.`);
    }
    return state.client;
  }
}
