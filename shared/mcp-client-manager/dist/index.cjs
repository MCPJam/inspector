"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// index.ts
var index_exports = {};
__export(index_exports, {
  MCPClientManager: () => MCPClientManager
});
module.exports = __toCommonJS(index_exports);
var import_client = require("@modelcontextprotocol/sdk/client/index.js");
var import_sse = require("@modelcontextprotocol/sdk/client/sse.js");
var import_stdio = require("@modelcontextprotocol/sdk/client/stdio.js");
var import_streamableHttp = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
var import_protocol = require("@modelcontextprotocol/sdk/shared/protocol.js");
var import_types = require("@modelcontextprotocol/sdk/types.js");
var MCPClientManager = class {
  constructor(servers = {}, options = {}) {
    this.clientStates = /* @__PURE__ */ new Map();
    this.notificationHandlers = /* @__PURE__ */ new Map();
    this.elicitationHandlers = /* @__PURE__ */ new Map();
    this.toolsMetadataCache = /* @__PURE__ */ new Map();
    var _a, _b, _c;
    this.defaultClientVersion = (_a = options.defaultClientVersion) != null ? _a : "1.0.0";
    this.defaultCapabilities = { ...(_b = options.defaultCapabilities) != null ? _b : {} };
    this.defaultTimeout = (_c = options.defaultTimeout) != null ? _c : import_protocol.DEFAULT_REQUEST_TIMEOUT_MSEC;
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
      const client = new import_client.Client(
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
        transport = await this.connectViaStdio(client, config, timeout);
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
  async executeTool(serverId, toolName, args = {}, options) {
    await this.ensureConnected(serverId);
    const client = this.getClientById(serverId);
    return client.callTool(
      {
        name: toolName,
        arguments: args
      },
      import_types.CallToolResultSchema,
      this.withTimeout(serverId, options)
    );
  }
  async listResources(serverId, params, options) {
    await this.ensureConnected(serverId);
    const client = this.getClientById(serverId);
    return client.listResources(params, this.withTimeout(serverId, options));
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
    return client.listPrompts(params, this.withTimeout(serverId, options));
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
    if (state.transport instanceof import_streamableHttp.StreamableHTTPClientTransport) {
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
      import_types.ResourceListChangedNotificationSchema,
      handler
    );
  }
  onResourceUpdated(serverId, handler) {
    this.addNotificationHandler(
      serverId,
      import_types.ResourceUpdatedNotificationSchema,
      handler
    );
  }
  onPromptListChanged(serverId, handler) {
    this.addNotificationHandler(
      serverId,
      import_types.PromptListChangedNotificationSchema,
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
  async connectViaStdio(client, config, timeout) {
    var _a;
    const transport = new import_stdio.StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...(0, import_stdio.getDefaultEnvironment)(), ...(_a = config.env) != null ? _a : {} }
    });
    await client.connect(transport, { timeout });
    return transport;
  }
  async connectViaHttp(serverId, client, config, timeout) {
    var _a;
    const preferSSE = (_a = config.preferSSE) != null ? _a : config.url.pathname.endsWith("/sse");
    let streamableError;
    if (!preferSSE) {
      const streamableTransport = new import_streamableHttp.StreamableHTTPClientTransport(
        config.url,
        {
          requestInit: config.requestInit,
          reconnectionOptions: config.reconnectionOptions,
          authProvider: config.authProvider,
          sessionId: config.sessionId
        }
      );
      try {
        await client.connect(streamableTransport, {
          timeout: Math.min(timeout, 3e3)
        });
        return streamableTransport;
      } catch (error) {
        streamableError = error;
        await this.safeCloseTransport(streamableTransport);
      }
    }
    const sseTransport = new import_sse.SSEClientTransport(config.url, {
      requestInit: config.requestInit,
      eventSourceInit: config.eventSourceInit,
      authProvider: config.authProvider
    });
    try {
      await client.connect(sseTransport, { timeout });
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
    const handler = this.elicitationHandlers.get(serverId);
    if (!handler) {
      return;
    }
    client.setRequestHandler(
      import_types.ElicitRequestSchema,
      async (request) => handler(request.params)
    );
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MCPClientManager
});
//# sourceMappingURL=index.cjs.map