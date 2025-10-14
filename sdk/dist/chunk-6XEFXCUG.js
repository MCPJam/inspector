var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// mcp-client-manager/index.ts
var mcp_client_manager_exports = {};
__export(mcp_client_manager_exports, {
  MCPClientManager: () => MCPClientManager
});
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  getDefaultEnvironment,
  StdioClientTransport
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  CallToolResultSchema as CallToolResultSchema2,
  ElicitRequestSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  PromptListChangedNotificationSchema
} from "@modelcontextprotocol/sdk/types.js";

// mcp-client-manager/tool-converters.ts
import {
  CallToolResultSchema
} from "@modelcontextprotocol/sdk/types.js";
import {
  dynamicTool,
  jsonSchema,
  tool as defineTool
} from "ai";
var ensureJsonSchemaObject = (schema) => {
  var _a;
  if (schema && typeof schema === "object") {
    const record = schema;
    const base = record.jsonSchema ? ensureJsonSchemaObject(record.jsonSchema) : record;
    if (!("type" in base) || base.type === void 0) {
      base.type = "object";
    }
    if (base.type === "object") {
      base.properties = (_a = base.properties) != null ? _a : {};
      if (base.additionalProperties === void 0) {
        base.additionalProperties = false;
      }
    }
    return base;
  }
  return {
    type: "object",
    properties: {},
    additionalProperties: false
  };
};
async function convertMCPToolsToVercelTools(listToolsResult, {
  schemas = "automatic",
  callTool
}) {
  var _a, _b;
  const tools = {};
  for (const toolDescription of listToolsResult.tools) {
    const { name, description, inputSchema } = toolDescription;
    const execute = async (args, options) => {
      var _a2, _b2;
      (_b2 = (_a2 = options == null ? void 0 : options.abortSignal) == null ? void 0 : _a2.throwIfAborted) == null ? void 0 : _b2.call(_a2);
      const result = await callTool({ name, args, options });
      return CallToolResultSchema.parse(result);
    };
    let vercelTool;
    if (schemas === "automatic") {
      const normalizedInputSchema = ensureJsonSchemaObject(inputSchema);
      vercelTool = dynamicTool({
        description,
        inputSchema: jsonSchema({
          type: "object",
          properties: (_a = normalizedInputSchema.properties) != null ? _a : {},
          additionalProperties: (_b = normalizedInputSchema.additionalProperties) != null ? _b : false
        }),
        execute
      });
    } else {
      const overrides = schemas;
      if (!(name in overrides)) {
        continue;
      }
      vercelTool = defineTool({
        description,
        inputSchema: overrides[name].inputSchema,
        execute
      });
    }
    tools[name] = vercelTool;
  }
  return tools;
}

// mcp-client-manager/index.ts
var MCPClientManager = class {
  constructor(servers = {}, options = {}) {
    this.clientStates = /* @__PURE__ */ new Map();
    this.notificationHandlers = /* @__PURE__ */ new Map();
    this.elicitationHandlers = /* @__PURE__ */ new Map();
    this.toolsMetadataCache = /* @__PURE__ */ new Map();
    // Default JSON-RPC logging controls
    this.defaultLogJsonRpc = false;
    this.pendingElicitations = /* @__PURE__ */ new Map();
    var _a, _b, _c, _d;
    this.defaultClientVersion = (_a = options.defaultClientVersion) != null ? _a : "1.0.0";
    this.defaultCapabilities = { ...(_b = options.defaultCapabilities) != null ? _b : {} };
    this.defaultTimeout = (_c = options.defaultTimeout) != null ? _c : DEFAULT_REQUEST_TIMEOUT_MSEC;
    this.defaultLogJsonRpc = (_d = options.defaultLogJsonRpc) != null ? _d : false;
    this.defaultRpcLogger = options.rpcLogger;
    for (const [id, config] of Object.entries(servers)) {
      void this.connectToServer(id, config);
    }
  }
  listServers() {
    return Array.from(this.clientStates.keys());
  }
  hasServer(serverId) {
    return this.clientStates.has(serverId);
  }
  getServerSummaries() {
    return Array.from(this.clientStates.entries()).map(([serverId, state]) => ({
      id: serverId,
      status: this.resolveConnectionStatus(state),
      config: state.config
    }));
  }
  getConnectionStatus(serverId) {
    return this.resolveConnectionStatus(this.clientStates.get(serverId));
  }
  getServerConfig(serverId) {
    var _a;
    return (_a = this.clientStates.get(serverId)) == null ? void 0 : _a.config;
  }
  async connectToServer(serverId, config) {
    var _a;
    if (this.clientStates.has(serverId)) {
      throw new Error(`MCP server "${serverId}" is already connected.`);
    }
    const timeout = this.getTimeout(config);
    const state = (_a = this.clientStates.get(serverId)) != null ? _a : {
      config,
      timeout
    };
    state.config = config;
    state.timeout = timeout;
    if (state.client) {
      this.clientStates.set(serverId, state);
      return state.client;
    }
    if (state.promise) {
      this.clientStates.set(serverId, state);
      return state.promise;
    }
    const connectionPromise = (async () => {
      var _a2;
      const client = new Client(
        {
          name: serverId,
          version: (_a2 = config.version) != null ? _a2 : this.defaultClientVersion
        },
        {
          capabilities: this.buildCapabilities(config)
        }
      );
      this.applyNotificationHandlers(serverId, client);
      this.applyElicitationHandler(serverId, client);
      if (config.onError) {
        client.onerror = (error) => {
          var _a3;
          (_a3 = config.onError) == null ? void 0 : _a3.call(config, error);
        };
      }
      client.onclose = () => {
        this.resetState(serverId);
      };
      let transport;
      if (this.isStdioConfig(config)) {
        transport = await this.connectViaStdio(
          serverId,
          client,
          config,
          timeout
        );
      } else {
        transport = await this.connectViaHttp(
          serverId,
          client,
          config,
          timeout
        );
      }
      state.client = client;
      state.transport = transport;
      state.promise = void 0;
      this.clientStates.set(serverId, state);
      return client;
    })().catch((error) => {
      state.promise = void 0;
      state.client = void 0;
      state.transport = void 0;
      this.clientStates.set(serverId, state);
      throw error;
    });
    state.promise = connectionPromise;
    this.clientStates.set(serverId, state);
    return connectionPromise;
  }
  async disconnectServer(serverId) {
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
  removeServer(serverId) {
    this.resetState(serverId);
    this.notificationHandlers.delete(serverId);
    this.elicitationHandlers.delete(serverId);
  }
  async disconnectAllServers() {
    const serverIds = this.listServers();
    await Promise.all(
      serverIds.map((serverId) => this.disconnectServer(serverId))
    );
    for (const serverId of serverIds) {
      this.resetState(serverId);
      this.notificationHandlers.delete(serverId);
      this.elicitationHandlers.delete(serverId);
    }
  }
  async listTools(serverId, params, options) {
    await this.ensureConnected(serverId);
    const client = this.getClientById(serverId);
    try {
      const result = await client.listTools(
        params,
        this.withTimeout(serverId, options)
      );
      const metadataMap = /* @__PURE__ */ new Map();
      for (const tool of result.tools) {
        if (tool._meta) {
          metadataMap.set(tool.name, tool._meta);
        }
      }
      this.toolsMetadataCache.set(serverId, metadataMap);
      return result;
    } catch (error) {
      if (this.isMethodUnavailableError(error, "tools/list")) {
        this.toolsMetadataCache.set(serverId, /* @__PURE__ */ new Map());
        return { tools: [] };
      }
      throw error;
    }
  }
  async getTools(serverIds) {
    const targetServerIds = serverIds && serverIds.length > 0 ? serverIds : this.listServers();
    const toolLists = await Promise.all(
      targetServerIds.map(async (serverId) => {
        await this.ensureConnected(serverId);
        const client = this.getClientById(serverId);
        const result = await client.listTools(
          void 0,
          this.withTimeout(serverId)
        );
        const metadataMap = /* @__PURE__ */ new Map();
        for (const tool of result.tools) {
          if (tool._meta) {
            metadataMap.set(tool.name, tool._meta);
          }
        }
        this.toolsMetadataCache.set(serverId, metadataMap);
        return result.tools;
      })
    );
    return { tools: toolLists.flat() };
  }
  getAllToolsMetadata(serverId) {
    const metadataMap = this.toolsMetadataCache.get(serverId);
    return metadataMap ? Object.fromEntries(metadataMap) : {};
  }
  pingServer(serverId, options) {
    const client = this.getClientById(serverId);
    try {
      client.ping(options);
    } catch (error) {
      throw new Error(
        `Failed to ping MCP server "${serverId}": ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }
  async getToolsForAiSdk(serverIds, options = {}) {
    const ids = Array.isArray(serverIds) ? serverIds : serverIds ? [serverIds] : this.listServers();
    const loadForServer = async (id) => {
      await this.ensureConnected(id);
      const listToolsResult = await this.listTools(id);
      return convertMCPToolsToVercelTools(listToolsResult, {
        schemas: options.schemas,
        callTool: async ({ name, args, options: callOptions }) => {
          const requestOptions = (callOptions == null ? void 0 : callOptions.abortSignal) ? { signal: callOptions.abortSignal } : void 0;
          const result = await this.executeTool(
            id,
            name,
            args != null ? args : {},
            requestOptions
          );
          return CallToolResultSchema2.parse(result);
        }
      });
    };
    const perServerTools = await Promise.all(
      ids.map(async (id) => {
        try {
          const tools = await loadForServer(id);
          for (const [name, tool] of Object.entries(tools)) {
            tool._serverId = id;
          }
          return tools;
        } catch (error) {
          if (this.isMethodUnavailableError(error, "tools/list")) {
            return {};
          }
          throw error;
        }
      })
    );
    const flattened = {};
    for (const toolset of perServerTools) {
      for (const [name, tool] of Object.entries(toolset)) {
        flattened[name] = tool;
      }
    }
    return flattened;
  }
  async executeTool(serverId, toolName, args = {}, options) {
    await this.ensureConnected(serverId);
    const client = this.getClientById(serverId);
    return client.callTool(
      {
        name: toolName,
        arguments: args
      },
      CallToolResultSchema2,
      this.withTimeout(serverId, options)
    );
  }
  async listResources(serverId, params, options) {
    await this.ensureConnected(serverId);
    const client = this.getClientById(serverId);
    try {
      return await client.listResources(
        params,
        this.withTimeout(serverId, options)
      );
    } catch (error) {
      if (this.isMethodUnavailableError(error, "resources/list")) {
        return {
          resources: []
        };
      }
      throw error;
    }
  }
  async readResource(serverId, params, options) {
    await this.ensureConnected(serverId);
    const client = this.getClientById(serverId);
    return client.readResource(params, this.withTimeout(serverId, options));
  }
  async subscribeResource(serverId, params, options) {
    await this.ensureConnected(serverId);
    const client = this.getClientById(serverId);
    return client.subscribeResource(
      params,
      this.withTimeout(serverId, options)
    );
  }
  async unsubscribeResource(serverId, params, options) {
    await this.ensureConnected(serverId);
    const client = this.getClientById(serverId);
    return client.unsubscribeResource(
      params,
      this.withTimeout(serverId, options)
    );
  }
  async listResourceTemplates(serverId, params, options) {
    await this.ensureConnected(serverId);
    const client = this.getClientById(serverId);
    return client.listResourceTemplates(
      params,
      this.withTimeout(serverId, options)
    );
  }
  async listPrompts(serverId, params, options) {
    await this.ensureConnected(serverId);
    const client = this.getClientById(serverId);
    try {
      return await client.listPrompts(
        params,
        this.withTimeout(serverId, options)
      );
    } catch (error) {
      if (this.isMethodUnavailableError(error, "prompts/list")) {
        return {
          prompts: []
        };
      }
      throw error;
    }
  }
  async getPrompt(serverId, params, options) {
    await this.ensureConnected(serverId);
    const client = this.getClientById(serverId);
    return client.getPrompt(params, this.withTimeout(serverId, options));
  }
  getSessionIdByServer(serverId) {
    const state = this.clientStates.get(serverId);
    if (!(state == null ? void 0 : state.transport)) {
      throw new Error(`Unknown MCP server "${serverId}".`);
    }
    if (state.transport instanceof StreamableHTTPClientTransport) {
      return state.transport.sessionId;
    }
    throw new Error(
      `Server "${serverId}" must be Streamable HTTP to get the session ID.`
    );
  }
  addNotificationHandler(serverId, schema, handler) {
    var _a, _b, _c;
    const serverHandlers = (_a = this.notificationHandlers.get(serverId)) != null ? _a : /* @__PURE__ */ new Map();
    const handlersForSchema = (_b = serverHandlers.get(schema)) != null ? _b : /* @__PURE__ */ new Set();
    handlersForSchema.add(handler);
    serverHandlers.set(schema, handlersForSchema);
    this.notificationHandlers.set(serverId, serverHandlers);
    const client = (_c = this.clientStates.get(serverId)) == null ? void 0 : _c.client;
    if (client) {
      client.setNotificationHandler(
        schema,
        this.createNotificationDispatcher(serverId, schema)
      );
    }
  }
  onResourceListChanged(serverId, handler) {
    this.addNotificationHandler(
      serverId,
      ResourceListChangedNotificationSchema,
      handler
    );
  }
  onResourceUpdated(serverId, handler) {
    this.addNotificationHandler(
      serverId,
      ResourceUpdatedNotificationSchema,
      handler
    );
  }
  onPromptListChanged(serverId, handler) {
    this.addNotificationHandler(
      serverId,
      PromptListChangedNotificationSchema,
      handler
    );
  }
  getClient(serverId) {
    var _a;
    return (_a = this.clientStates.get(serverId)) == null ? void 0 : _a.client;
  }
  setElicitationHandler(serverId, handler) {
    var _a;
    if (!this.clientStates.has(serverId)) {
      throw new Error(`Unknown MCP server "${serverId}".`);
    }
    this.elicitationHandlers.set(serverId, handler);
    const client = (_a = this.clientStates.get(serverId)) == null ? void 0 : _a.client;
    if (client) {
      this.applyElicitationHandler(serverId, client);
    }
  }
  clearElicitationHandler(serverId) {
    var _a;
    this.elicitationHandlers.delete(serverId);
    const client = (_a = this.clientStates.get(serverId)) == null ? void 0 : _a.client;
    if (client) {
      client.removeRequestHandler("elicitation/create");
    }
  }
  // Global elicitation callback API (no serverId required)
  setElicitationCallback(callback) {
    this.elicitationCallback = callback;
    for (const [serverId, state] of this.clientStates.entries()) {
      const client = state.client;
      if (!client) continue;
      if (this.elicitationHandlers.has(serverId)) {
        this.applyElicitationHandler(serverId, client);
      } else {
        this.applyElicitationHandler(serverId, client);
      }
    }
  }
  clearElicitationCallback() {
    this.elicitationCallback = void 0;
    for (const [serverId, state] of this.clientStates.entries()) {
      const client = state.client;
      if (!client) continue;
      if (this.elicitationHandlers.has(serverId)) {
        this.applyElicitationHandler(serverId, client);
      } else {
        client.removeRequestHandler("elicitation/create");
      }
    }
  }
  // Expose the pending elicitation map so callers can add resolvers
  getPendingElicitations() {
    return this.pendingElicitations;
  }
  // Helper to resolve a pending elicitation from outside
  respondToElicitation(requestId, response) {
    const pending = this.pendingElicitations.get(requestId);
    if (!pending) return false;
    try {
      pending.resolve(response);
      return true;
    } finally {
      this.pendingElicitations.delete(requestId);
    }
  }
  async connectViaStdio(serverId, client, config, timeout) {
    var _a;
    const underlying = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...getDefaultEnvironment(), ...(_a = config.env) != null ? _a : {} }
    });
    const wrapped = this.wrapTransportForLogging(serverId, config, underlying);
    await client.connect(wrapped, { timeout });
    return underlying;
  }
  async connectViaHttp(serverId, client, config, timeout) {
    var _a;
    const preferSSE = (_a = config.preferSSE) != null ? _a : config.url.pathname.endsWith("/sse");
    let streamableError;
    if (!preferSSE) {
      const streamableTransport = new StreamableHTTPClientTransport(
        config.url,
        {
          requestInit: config.requestInit,
          reconnectionOptions: config.reconnectionOptions,
          authProvider: config.authProvider,
          sessionId: config.sessionId
        }
      );
      try {
        const wrapped = this.wrapTransportForLogging(
          serverId,
          config,
          streamableTransport
        );
        await client.connect(wrapped, {
          timeout: Math.min(timeout, 3e3)
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
      authProvider: config.authProvider
    });
    try {
      const wrapped = this.wrapTransportForLogging(
        serverId,
        config,
        sseTransport
      );
      await client.connect(wrapped, { timeout });
      return sseTransport;
    } catch (error) {
      await this.safeCloseTransport(sseTransport);
      const streamableMessage = streamableError ? ` Streamable HTTP error: ${this.formatError(streamableError)}.` : "";
      throw new Error(
        `Failed to connect to MCP server "${serverId}" using HTTP transports.${streamableMessage} SSE error: ${this.formatError(error)}.`
      );
    }
  }
  async safeCloseTransport(transport) {
    try {
      await transport.close();
    } catch {
    }
  }
  applyNotificationHandlers(serverId, client) {
    const serverHandlers = this.notificationHandlers.get(serverId);
    if (!serverHandlers) {
      return;
    }
    for (const [schema] of serverHandlers) {
      client.setNotificationHandler(
        schema,
        this.createNotificationDispatcher(serverId, schema)
      );
    }
  }
  createNotificationDispatcher(serverId, schema) {
    return (notification) => {
      const serverHandlers = this.notificationHandlers.get(serverId);
      const handlersForSchema = serverHandlers == null ? void 0 : serverHandlers.get(schema);
      if (!handlersForSchema || handlersForSchema.size === 0) {
        return;
      }
      for (const handler of handlersForSchema) {
        try {
          handler(notification);
        } catch {
        }
      }
    };
  }
  applyElicitationHandler(serverId, client) {
    const serverSpecific = this.elicitationHandlers.get(serverId);
    if (serverSpecific) {
      client.setRequestHandler(
        ElicitRequestSchema,
        async (request) => serverSpecific(request.params)
      );
      return;
    }
    if (this.elicitationCallback) {
      client.setRequestHandler(ElicitRequestSchema, async (request) => {
        var _a, _b, _c, _d;
        const reqId = `elicit_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        return await this.elicitationCallback({
          requestId: reqId,
          message: (_a = request.params) == null ? void 0 : _a.message,
          schema: (_d = (_b = request.params) == null ? void 0 : _b.requestedSchema) != null ? _d : (_c = request.params) == null ? void 0 : _c.schema
        });
      });
      return;
    }
  }
  async ensureConnected(serverId) {
    const state = this.clientStates.get(serverId);
    if (state == null ? void 0 : state.client) {
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
  resetState(serverId) {
    this.clientStates.delete(serverId);
    this.toolsMetadataCache.delete(serverId);
  }
  resolveConnectionStatus(state) {
    if (!state) {
      return "disconnected";
    }
    if (state.client) {
      return "connected";
    }
    if (state.promise) {
      return "connecting";
    }
    return "disconnected";
  }
  withTimeout(serverId, options) {
    var _a;
    const state = this.clientStates.get(serverId);
    const timeout = (_a = state == null ? void 0 : state.timeout) != null ? _a : state ? this.getTimeout(state.config) : this.defaultTimeout;
    if (!options) {
      return { timeout };
    }
    if (options.timeout === void 0) {
      return { ...options, timeout };
    }
    return options;
  }
  buildCapabilities(config) {
    var _a;
    const capabilities = {
      ...this.defaultCapabilities,
      ...(_a = config.capabilities) != null ? _a : {}
    };
    if (!capabilities.elicitation) {
      capabilities.elicitation = {};
    }
    return capabilities;
  }
  formatError(error) {
    if (error instanceof Error) {
      return error.message;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  // Returns a transport that logs JSON-RPC traffic if enabled for this server
  wrapTransportForLogging(serverId, config, transport) {
    const logger = this.resolveRpcLogger(serverId, config);
    if (!logger) return transport;
    const log = logger;
    const self = this;
    class LoggingTransport {
      constructor(inner) {
        this.inner = inner;
        this.inner.onmessage = (message, extra) => {
          var _a;
          try {
            log({ direction: "receive", message, serverId });
          } catch {
          }
          (_a = this.onmessage) == null ? void 0 : _a.call(this, message, extra);
        };
        this.inner.onclose = () => {
          var _a;
          (_a = this.onclose) == null ? void 0 : _a.call(this);
        };
        this.inner.onerror = (error) => {
          var _a;
          (_a = this.onerror) == null ? void 0 : _a.call(this, error);
        };
      }
      async start() {
        if (typeof this.inner.start === "function") {
          await this.inner.start();
        }
      }
      async send(message, options) {
        try {
          log({ direction: "send", message, serverId });
        } catch {
        }
        await this.inner.send(message, options);
      }
      async close() {
        await this.inner.close();
      }
      get sessionId() {
        return this.inner.sessionId;
      }
      setProtocolVersion(version) {
        if (typeof this.inner.setProtocolVersion === "function") {
          this.inner.setProtocolVersion(version);
        }
      }
    }
    return new LoggingTransport(transport);
  }
  resolveRpcLogger(serverId, config) {
    if (config.rpcLogger) return config.rpcLogger;
    if (config.logJsonRpc || this.defaultLogJsonRpc) {
      return ({ direction, message, serverId: id }) => {
        let printable;
        try {
          printable = typeof message === "string" ? message : JSON.stringify(message);
        } catch {
          printable = String(message);
        }
        console.debug(`[MCP:${id}] ${direction.toUpperCase()} ${printable}`);
      };
    }
    if (this.defaultRpcLogger) return this.defaultRpcLogger;
    return void 0;
  }
  isMethodUnavailableError(error, method) {
    if (!(error instanceof Error)) {
      return false;
    }
    const message = error.message.toLowerCase();
    const methodTokens = /* @__PURE__ */ new Set();
    const pushToken = (token) => {
      if (token) {
        methodTokens.add(token.toLowerCase());
      }
    };
    pushToken(method);
    for (const part of method.split(/[\/:._-]/)) {
      pushToken(part);
    }
    const indicators = [
      "method not found",
      "not implemented",
      "unsupported",
      "does not support",
      "unimplemented"
    ];
    const indicatorMatch = indicators.some(
      (indicator) => message.includes(indicator)
    );
    if (!indicatorMatch) {
      return false;
    }
    if (Array.from(methodTokens).some((token) => message.includes(token))) {
      return true;
    }
    return true;
  }
  getTimeout(config) {
    var _a;
    return (_a = config.timeout) != null ? _a : this.defaultTimeout;
  }
  isStdioConfig(config) {
    return "command" in config;
  }
  getClientById(serverId) {
    const state = this.clientStates.get(serverId);
    if (!(state == null ? void 0 : state.client)) {
      throw new Error(`MCP server "${serverId}" is not connected.`);
    }
    return state.client;
  }
};

export {
  MCPClientManager,
  mcp_client_manager_exports
};
//# sourceMappingURL=chunk-6XEFXCUG.js.map