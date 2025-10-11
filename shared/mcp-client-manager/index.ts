import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ClientOptions } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { SSEClientTransportOptions } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { StreamableHTTPClientTransportOptions } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolResultSchema,
  ElicitRequestSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  PromptListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  ElicitRequest,
  ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
type ClientCapabilityOptions = NonNullable<ClientOptions["capabilities"]>;

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
  requestInit?: StreamableHTTPClientTransportOptions["requestInit"];
  eventSourceInit?: SSEClientTransportOptions["eventSourceInit"];
  authProvider?: StreamableHTTPClientTransportOptions["authProvider"];
  reconnectionOptions?: StreamableHTTPClientTransportOptions["reconnectionOptions"];
  sessionId?: StreamableHTTPClientTransportOptions["sessionId"];
  preferSSE?: boolean;

  command?: never;
  args?: never;
  env?: never;
};

export type MCPServerConfig = StdioServerConfig | HttpServerConfig;

export type MCPClientManagerConfig = Record<string, MCPServerConfig>;

type NotificationSchema = Parameters<Client["setNotificationHandler"]>[0];
type NotificationHandler = Parameters<Client["setNotificationHandler"]>[1];

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

type ListResourcesParams = Parameters<Client["listResources"]>[0];
type ListResourceTemplatesParams = Parameters<
  Client["listResourceTemplates"]
>[0];
type ReadResourceParams = Parameters<Client["readResource"]>[0];
type SubscribeResourceParams = Parameters<Client["subscribeResource"]>[0];
type UnsubscribeResourceParams = Parameters<Client["unsubscribeResource"]>[0];
type ListPromptsParams = Parameters<Client["listPrompts"]>[0];
type GetPromptParams = Parameters<Client["getPrompt"]>[0];
type ListToolsResult = Awaited<ReturnType<Client["listTools"]>>;

export type ExecuteToolArguments = Record<string, unknown>;
export type ElicitationHandler = (
  params: ElicitRequest["params"],
) => Promise<ElicitResult> | ElicitResult;

export class MCPClientManager {
  private readonly clientStates = new Map<string, ManagedClientState>();
  private readonly notificationHandlers = new Map<
    string,
    Map<NotificationSchema, Set<NotificationHandler>>
  >();
  private readonly elicitationHandlers = new Map<string, ElicitationHandler>();
  private readonly toolsCache = new Map<string, Map<string, any>>();
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
    this.defaultClientVersion = options.defaultClientVersion ?? "1.0.0";
    this.defaultCapabilities = { ...(options.defaultCapabilities ?? {}) };
    this.defaultTimeout =
      options.defaultTimeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC;

    for (const [id, config] of Object.entries(servers)) {
      void this.connectToServer(id, config);
    }
  }

  listServers(): string[] {
    return Array.from(this.clientStates.keys());
  }

  hasServer(serverId: string): boolean {
    return this.clientStates.has(serverId);
  }

  async connectToServer(
    serverId: string,
    config: MCPServerConfig,
  ): Promise<Client> {
    if (this.clientStates.has(serverId)) {
      throw new Error(`MCP server "${serverId}" is already connected.`);
    }
    const timeout = this.getTimeout(config);
    const state = this.clientStates.get(serverId) ?? {
      config,
      timeout,
    };
    // Update config/timeout on every call
    state.config = config;
    state.timeout = timeout;
    // If already connected, return the client
    if (state.client) {
      this.clientStates.set(serverId, state);
      return state.client;
    }
    // If connection is in-flight, reuse the promise
    if (state.promise) {
      this.clientStates.set(serverId, state);
      return state.promise;
    }

    const connectionPromise = (async () => {
      const client = new Client(
        {
          name: serverId,
          version: config.version ?? this.defaultClientVersion,
        },
        {
          capabilities: this.buildCapabilities(config),
        },
      );

      this.applyNotificationHandlers(serverId, client);
      this.applyElicitationHandler(serverId, client);

      if (config.onError) {
        client.onerror = (error) => {
          config.onError?.(error);
        };
      }

      client.onclose = () => {
        this.resetState(serverId);
      };

      let transport: Transport;
      if (this.isStdioConfig(config)) {
        transport = await this.connectViaStdio(client, config, timeout);
      } else {
        transport = await this.connectViaHttp(
          serverId,
          client,
          config,
          timeout,
        );
      }

      state.client = client;
      state.transport = transport;
      // clear pending
      state.promise = undefined;
      this.clientStates.set(serverId, state);

      return client;
    })().catch((error) => {
      // Clear pending but keep config so the server remains registered
      state.promise = undefined;
      state.client = undefined;
      state.transport = undefined;
      this.clientStates.set(serverId, state);
      throw error;
    });

    state.promise = connectionPromise;
    this.clientStates.set(serverId, state);
    return connectionPromise;
  }

  async disconnectServer(serverId: string): Promise<void> {
    const client = this.getClientById(serverId);
    try {
      await client.close();
    } finally {
      if (client.transport) {
        await this.safeCloseTransport(client.transport);
      }
      this.resetState(serverId);
    }
  }

  async disconnectAllServers(): Promise<void> {
    const serverIds = this.listServers();
    await Promise.all(
      serverIds.map((serverId) => this.disconnectServer(serverId)),
    );

    for (const serverId of serverIds) {
      this.resetState(serverId);
      this.notificationHandlers.delete(serverId);
      this.elicitationHandlers.delete(serverId);
    }
  }

  async listTools(
    serverId: string,
    params?: Parameters<Client["listTools"]>[0],
    options?: ClientRequestOptions,
  ) {
    await this.ensureConnected(serverId);
    const client = this.getClientById(serverId);
    const result = await client.listTools(
      params,
      this.withTimeout(serverId, options),
    );

    const metadataMap = new Map<string, any>();
    for (const tool of result.tools) {
      if (tool._meta) {
        metadataMap.set(tool.name, tool._meta);
      }
    }
    this.toolsCache.set(serverId, metadataMap);

    return result;
  }

  async getTools(serverIds?: string[]): Promise<ListToolsResult> {
    const targetServerIds =
      serverIds && serverIds.length > 0 ? serverIds : this.listServers();

    const toolLists = await Promise.all(
      targetServerIds.map(async (serverId) => {
        await this.ensureConnected(serverId);
        const client = this.getClientById(serverId);
        const result = await client.listTools(
          undefined,
          this.withTimeout(serverId),
        );

        const metadataMap = new Map<string, any>();
        for (const tool of result.tools) {
          if (tool._meta) {
            metadataMap.set(tool.name, tool._meta);
          }
        }
        this.toolsCache.set(serverId, metadataMap);

        return result.tools;
      }),
    );

    return { tools: toolLists.flat() };
  }

  getToolMetadata(
    serverId: string,
    toolName: string,
  ): Record<string, any> | undefined {
    return this.toolsCache.get(serverId)?.get(toolName);
  }

  getAllToolsMetadata(serverId: string): Record<string, Record<string, any>> {
    const metadataMap = this.toolsCache.get(serverId);
    return metadataMap ? Object.fromEntries(metadataMap) : {};
  }

  async executeTool(
    serverId: string,
    toolName: string,
    args: ExecuteToolArguments = {},
    options?: CallToolOptions,
  ) {
    await this.ensureConnected(serverId);
    const client = this.getClientById(serverId);
    return client.callTool(
      {
        name: toolName,
        arguments: args,
      },
      CallToolResultSchema,
      this.withTimeout(serverId, options),
    );
  }

  async listResources(
    serverId: string,
    params?: ListResourcesParams,
    options?: ClientRequestOptions,
  ) {
    await this.ensureConnected(serverId);
    const client = this.getClientById(serverId);
    return client.listResources(params, this.withTimeout(serverId, options));
  }

  async readResource(
    serverId: string,
    params: ReadResourceParams,
    options?: ClientRequestOptions,
  ) {
    await this.ensureConnected(serverId);
    const client = this.getClientById(serverId);
    return client.readResource(params, this.withTimeout(serverId, options));
  }

  async subscribeResource(
    serverId: string,
    params: SubscribeResourceParams,
    options?: ClientRequestOptions,
  ) {
    await this.ensureConnected(serverId);
    const client = this.getClientById(serverId);
    return client.subscribeResource(
      params,
      this.withTimeout(serverId, options),
    );
  }

  async unsubscribeResource(
    serverId: string,
    params: UnsubscribeResourceParams,
    options?: ClientRequestOptions,
  ) {
    await this.ensureConnected(serverId);
    const client = this.getClientById(serverId);
    return client.unsubscribeResource(
      params,
      this.withTimeout(serverId, options),
    );
  }

  async listResourceTemplates(
    serverId: string,
    params?: ListResourceTemplatesParams,
    options?: ClientRequestOptions,
  ) {
    await this.ensureConnected(serverId);
    const client = this.getClientById(serverId);
    return client.listResourceTemplates(
      params,
      this.withTimeout(serverId, options),
    );
  }

  async listPrompts(
    serverId: string,
    params?: ListPromptsParams,
    options?: ClientRequestOptions,
  ) {
    await this.ensureConnected(serverId);
    const client = this.getClientById(serverId);
    return client.listPrompts(params, this.withTimeout(serverId, options));
  }

  async getPrompt(
    serverId: string,
    params: GetPromptParams,
    options?: ClientRequestOptions,
  ) {
    await this.ensureConnected(serverId);
    const client = this.getClientById(serverId);
    return client.getPrompt(params, this.withTimeout(serverId, options));
  }

  getSessionIdByServer(serverId: string): string | undefined {
    const state = this.clientStates.get(serverId);
    if (!state?.transport) {
      throw new Error(`Unknown MCP server "${serverId}".`);
    }
    if (state.transport instanceof StreamableHTTPClientTransport) {
      return state.transport.sessionId;
    }
    throw new Error(
      `Server "${serverId}" must be Streamable HTTP to get the session ID.`,
    );
  }

  addNotificationHandler(
    serverId: string,
    schema: NotificationSchema,
    handler: NotificationHandler,
  ): void {
    const serverHandlers = this.notificationHandlers.get(serverId) ?? new Map();
    const handlersForSchema =
      serverHandlers.get(schema) ?? new Set<NotificationHandler>();
    handlersForSchema.add(handler);
    serverHandlers.set(schema, handlersForSchema);
    this.notificationHandlers.set(serverId, serverHandlers);

    const client = this.clientStates.get(serverId)?.client;
    if (client) {
      client.setNotificationHandler(
        schema,
        this.createNotificationDispatcher(serverId, schema),
      );
    }
  }

  onResourceListChanged(serverId: string, handler: NotificationHandler): void {
    this.addNotificationHandler(
      serverId,
      ResourceListChangedNotificationSchema,
      handler,
    );
  }

  onResourceUpdated(serverId: string, handler: NotificationHandler): void {
    this.addNotificationHandler(
      serverId,
      ResourceUpdatedNotificationSchema,
      handler,
    );
  }

  onPromptListChanged(serverId: string, handler: NotificationHandler): void {
    this.addNotificationHandler(
      serverId,
      PromptListChangedNotificationSchema,
      handler,
    );
  }

  getClient(serverId: string): Client | undefined {
    return this.clientStates.get(serverId)?.client;
  }

  setElicitationHandler(serverId: string, handler: ElicitationHandler): void {
    if (!this.clientStates.has(serverId)) {
      throw new Error(`Unknown MCP server "${serverId}".`);
    }

    this.elicitationHandlers.set(serverId, handler);

    const client = this.clientStates.get(serverId)?.client;
    if (client) {
      this.applyElicitationHandler(serverId, client);
    }
  }

  clearElicitationHandler(serverId: string): void {
    this.elicitationHandlers.delete(serverId);
    const client = this.clientStates.get(serverId)?.client;
    if (client) {
      client.removeRequestHandler("elicitation/create");
    }
  }

  private async connectViaStdio(
    client: Client,
    config: StdioServerConfig,
    timeout: number,
  ): Promise<Transport> {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
    });
    await client.connect(transport, { timeout });
    return transport;
  }

  private async connectViaHttp(
    serverId: string,
    client: Client,
    config: HttpServerConfig,
    timeout: number,
  ): Promise<Transport> {
    const preferSSE = config.preferSSE ?? config.url.pathname.endsWith("/sse");
    let streamableError: unknown;

    if (!preferSSE) {
      const streamableTransport = new StreamableHTTPClientTransport(
        config.url,
        {
          requestInit: config.requestInit,
          reconnectionOptions: config.reconnectionOptions,
          authProvider: config.authProvider,
          sessionId: config.sessionId,
        },
      );

      try {
        await client.connect(streamableTransport, {
          timeout: Math.min(timeout, 3000),
        });
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
        : "";
      throw new Error(
        `Failed to connect to MCP server "${serverId}" using HTTP transports.${streamableMessage} SSE error: ${this.formatError(error)}.`,
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

  private applyNotificationHandlers(serverId: string, client: Client): void {
    const serverHandlers = this.notificationHandlers.get(serverId);
    if (!serverHandlers) {
      return;
    }

    for (const [schema] of serverHandlers) {
      client.setNotificationHandler(
        schema,
        this.createNotificationDispatcher(serverId, schema),
      );
    }
  }

  private createNotificationDispatcher(
    serverId: string,
    schema: NotificationSchema,
  ): NotificationHandler {
    return (notification) => {
      const serverHandlers = this.notificationHandlers.get(serverId);
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

  private applyElicitationHandler(serverId: string, client: Client): void {
    const handler = this.elicitationHandlers.get(serverId);
    if (!handler) {
      return;
    }

    client.setRequestHandler(ElicitRequestSchema, async (request) =>
      handler(request.params),
    );
  }

  private async ensureConnected(serverId: string): Promise<void> {
    const state = this.clientStates.get(serverId);
    if (state?.client) {
      return;
    }

    if (!state) {
      throw new Error(`Unknown MCP server "${serverId}".`);
    }
    if (state.promise) {
      await state.promise;
      return;
    }
    await this.connectToServer(serverId, state.config);
  }

  private resetState(serverId: string): void {
    this.clientStates.delete(serverId);
    this.toolsCache.delete(serverId);
  }

  private withTimeout(
    serverId: string,
    options?: RequestOptions,
  ): RequestOptions {
    const state = this.clientStates.get(serverId);
    const timeout =
      state?.timeout ??
      (state ? this.getTimeout(state.config) : this.defaultTimeout);

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
    return "command" in config;
  }

  private getClientById(serverId: string): Client {
    const state = this.clientStates.get(serverId);
    if (!state?.client) {
      throw new Error(`MCP server "${serverId}" is not connected.`);
    }
    return state.client;
  }
}
