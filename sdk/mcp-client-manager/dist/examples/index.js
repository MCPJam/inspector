import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getDefaultEnvironment, StdioClientTransport, } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { CallToolResultSchema, ElicitRequestSchema, ResourceListChangedNotificationSchema, ResourceUpdatedNotificationSchema, PromptListChangedNotificationSchema, } from "@modelcontextprotocol/sdk/types.js";
import { convertMCPToolsToVercelTools, } from "./tool-converters.js";
export class MCPClientManager {
    constructor(servers = {}, options = {}) {
        var _a, _b, _c;
        this.clientStates = new Map();
        this.notificationHandlers = new Map();
        this.elicitationHandlers = new Map();
        this.toolsMetadataCache = new Map();
        this.pendingElicitations = new Map();
        this.defaultClientVersion = (_a = options.defaultClientVersion) !== null && _a !== void 0 ? _a : "1.0.0";
        this.defaultCapabilities = { ...((_b = options.defaultCapabilities) !== null && _b !== void 0 ? _b : {}) };
        this.defaultTimeout =
            (_c = options.defaultTimeout) !== null && _c !== void 0 ? _c : DEFAULT_REQUEST_TIMEOUT_MSEC;
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
            config: state.config,
        }));
    }
    getConnectionStatus(serverId) {
        return this.resolveConnectionStatus(this.clientStates.get(serverId));
    }
    getServerConfig(serverId) {
        var _a;
        return (_a = this.clientStates.get(serverId)) === null || _a === void 0 ? void 0 : _a.config;
    }
    async connectToServer(serverId, config) {
        var _a;
        if (this.clientStates.has(serverId)) {
            throw new Error(`MCP server "${serverId}" is already connected.`);
        }
        const timeout = this.getTimeout(config);
        const state = (_a = this.clientStates.get(serverId)) !== null && _a !== void 0 ? _a : {
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
            var _a;
            const client = new Client({
                name: serverId,
                version: (_a = config.version) !== null && _a !== void 0 ? _a : this.defaultClientVersion,
            }, {
                capabilities: this.buildCapabilities(config),
            });
            this.applyNotificationHandlers(serverId, client);
            this.applyElicitationHandler(serverId, client);
            if (config.onError) {
                client.onerror = (error) => {
                    var _a;
                    (_a = config.onError) === null || _a === void 0 ? void 0 : _a.call(config, error);
                };
            }
            client.onclose = () => {
                this.resetState(serverId);
            };
            let transport;
            if (this.isStdioConfig(config)) {
                transport = await this.connectViaStdio(client, config, timeout);
            }
            else {
                transport = await this.connectViaHttp(serverId, client, config, timeout);
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
    async disconnectServer(serverId) {
        const client = this.getClientById(serverId);
        try {
            await client.close();
        }
        finally {
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
        await Promise.all(serverIds.map((serverId) => this.disconnectServer(serverId)));
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
            const result = await client.listTools(params, this.withTimeout(serverId, options));
            const metadataMap = new Map();
            for (const tool of result.tools) {
                if (tool._meta) {
                    metadataMap.set(tool.name, tool._meta);
                }
            }
            this.toolsMetadataCache.set(serverId, metadataMap);
            return result;
        }
        catch (error) {
            if (this.isMethodUnavailableError(error, "tools/list")) {
                this.toolsMetadataCache.set(serverId, new Map());
                return { tools: [] };
            }
            throw error;
        }
    }
    async getTools(serverIds) {
        const targetServerIds = serverIds && serverIds.length > 0 ? serverIds : this.listServers();
        const toolLists = await Promise.all(targetServerIds.map(async (serverId) => {
            await this.ensureConnected(serverId);
            const client = this.getClientById(serverId);
            const result = await client.listTools(undefined, this.withTimeout(serverId));
            const metadataMap = new Map();
            for (const tool of result.tools) {
                if (tool._meta) {
                    metadataMap.set(tool.name, tool._meta);
                }
            }
            this.toolsMetadataCache.set(serverId, metadataMap);
            return result.tools;
        }));
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
        }
        catch (error) {
            throw new Error(`Failed to ping MCP server "${serverId}": ${error instanceof Error ? error.message : "Unknown error"}`);
        }
    }
    async getToolsForAiSdk(serverIds, options = {}) {
        const ids = Array.isArray(serverIds)
            ? serverIds
            : serverIds
                ? [serverIds]
                : this.listServers();
        const loadForServer = async (id) => {
            await this.ensureConnected(id);
            const listToolsResult = await this.listTools(id);
            return convertMCPToolsToVercelTools(listToolsResult, {
                schemas: options.schemas,
                callTool: async ({ name, args, options: callOptions }) => {
                    const requestOptions = (callOptions === null || callOptions === void 0 ? void 0 : callOptions.abortSignal)
                        ? { signal: callOptions.abortSignal }
                        : undefined;
                    const result = await this.executeTool(id, name, (args !== null && args !== void 0 ? args : {}), requestOptions);
                    return CallToolResultSchema.parse(result);
                },
            });
        };
        const perServerTools = await Promise.all(ids.map(async (id) => {
            try {
                const tools = await loadForServer(id);
                // Attach server id metadata to each tool object for downstream extraction
                for (const [name, tool] of Object.entries(tools)) {
                    tool._serverId = id;
                }
                return tools;
            }
            catch (error) {
                if (this.isMethodUnavailableError(error, "tools/list")) {
                    return {};
                }
                throw error;
            }
        }));
        // Flatten into a single ToolSet (last-in wins for name collisions)
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
        return client.callTool({
            name: toolName,
            arguments: args,
        }, CallToolResultSchema, this.withTimeout(serverId, options));
    }
    async listResources(serverId, params, options) {
        await this.ensureConnected(serverId);
        const client = this.getClientById(serverId);
        try {
            return await client.listResources(params, this.withTimeout(serverId, options));
        }
        catch (error) {
            if (this.isMethodUnavailableError(error, "resources/list")) {
                return {
                    resources: [],
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
        return client.subscribeResource(params, this.withTimeout(serverId, options));
    }
    async unsubscribeResource(serverId, params, options) {
        await this.ensureConnected(serverId);
        const client = this.getClientById(serverId);
        return client.unsubscribeResource(params, this.withTimeout(serverId, options));
    }
    async listResourceTemplates(serverId, params, options) {
        await this.ensureConnected(serverId);
        const client = this.getClientById(serverId);
        return client.listResourceTemplates(params, this.withTimeout(serverId, options));
    }
    async listPrompts(serverId, params, options) {
        await this.ensureConnected(serverId);
        const client = this.getClientById(serverId);
        try {
            return await client.listPrompts(params, this.withTimeout(serverId, options));
        }
        catch (error) {
            if (this.isMethodUnavailableError(error, "prompts/list")) {
                return {
                    prompts: [],
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
        if (!(state === null || state === void 0 ? void 0 : state.transport)) {
            throw new Error(`Unknown MCP server "${serverId}".`);
        }
        if (state.transport instanceof StreamableHTTPClientTransport) {
            return state.transport.sessionId;
        }
        throw new Error(`Server "${serverId}" must be Streamable HTTP to get the session ID.`);
    }
    addNotificationHandler(serverId, schema, handler) {
        var _a, _b, _c;
        const serverHandlers = (_a = this.notificationHandlers.get(serverId)) !== null && _a !== void 0 ? _a : new Map();
        const handlersForSchema = (_b = serverHandlers.get(schema)) !== null && _b !== void 0 ? _b : new Set();
        handlersForSchema.add(handler);
        serverHandlers.set(schema, handlersForSchema);
        this.notificationHandlers.set(serverId, serverHandlers);
        const client = (_c = this.clientStates.get(serverId)) === null || _c === void 0 ? void 0 : _c.client;
        if (client) {
            client.setNotificationHandler(schema, this.createNotificationDispatcher(serverId, schema));
        }
    }
    onResourceListChanged(serverId, handler) {
        this.addNotificationHandler(serverId, ResourceListChangedNotificationSchema, handler);
    }
    onResourceUpdated(serverId, handler) {
        this.addNotificationHandler(serverId, ResourceUpdatedNotificationSchema, handler);
    }
    onPromptListChanged(serverId, handler) {
        this.addNotificationHandler(serverId, PromptListChangedNotificationSchema, handler);
    }
    getClient(serverId) {
        var _a;
        return (_a = this.clientStates.get(serverId)) === null || _a === void 0 ? void 0 : _a.client;
    }
    setElicitationHandler(serverId, handler) {
        var _a;
        if (!this.clientStates.has(serverId)) {
            throw new Error(`Unknown MCP server "${serverId}".`);
        }
        this.elicitationHandlers.set(serverId, handler);
        const client = (_a = this.clientStates.get(serverId)) === null || _a === void 0 ? void 0 : _a.client;
        if (client) {
            this.applyElicitationHandler(serverId, client);
        }
    }
    clearElicitationHandler(serverId) {
        var _a;
        this.elicitationHandlers.delete(serverId);
        const client = (_a = this.clientStates.get(serverId)) === null || _a === void 0 ? void 0 : _a.client;
        if (client) {
            client.removeRequestHandler("elicitation/create");
        }
    }
    // Global elicitation callback API (no serverId required)
    setElicitationCallback(callback) {
        this.elicitationCallback = callback;
        // Apply to all connected clients that don't have a server-specific handler
        for (const [serverId, state] of this.clientStates.entries()) {
            const client = state.client;
            if (!client)
                continue;
            if (this.elicitationHandlers.has(serverId)) {
                // Respect server-specific handler
                this.applyElicitationHandler(serverId, client);
            }
            else {
                this.applyElicitationHandler(serverId, client);
            }
        }
    }
    clearElicitationCallback() {
        this.elicitationCallback = undefined;
        // Reconfigure clients: keep server-specific handlers, otherwise remove
        for (const [serverId, state] of this.clientStates.entries()) {
            const client = state.client;
            if (!client)
                continue;
            if (this.elicitationHandlers.has(serverId)) {
                this.applyElicitationHandler(serverId, client);
            }
            else {
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
        if (!pending)
            return false;
        try {
            pending.resolve(response);
            return true;
        }
        finally {
            this.pendingElicitations.delete(requestId);
        }
    }
    async connectViaStdio(client, config, timeout) {
        var _a;
        const transport = new StdioClientTransport({
            command: config.command,
            args: config.args,
            env: { ...getDefaultEnvironment(), ...((_a = config.env) !== null && _a !== void 0 ? _a : {}) },
        });
        await client.connect(transport, { timeout });
        return transport;
    }
    async connectViaHttp(serverId, client, config, timeout) {
        var _a;
        const preferSSE = (_a = config.preferSSE) !== null && _a !== void 0 ? _a : config.url.pathname.endsWith("/sse");
        let streamableError;
        if (!preferSSE) {
            const streamableTransport = new StreamableHTTPClientTransport(config.url, {
                requestInit: config.requestInit,
                reconnectionOptions: config.reconnectionOptions,
                authProvider: config.authProvider,
                sessionId: config.sessionId,
            });
            try {
                await client.connect(streamableTransport, {
                    timeout: Math.min(timeout, 3000),
                });
                return streamableTransport;
            }
            catch (error) {
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
        }
        catch (error) {
            await this.safeCloseTransport(sseTransport);
            const streamableMessage = streamableError
                ? ` Streamable HTTP error: ${this.formatError(streamableError)}.`
                : "";
            throw new Error(`Failed to connect to MCP server "${serverId}" using HTTP transports.${streamableMessage} SSE error: ${this.formatError(error)}.`);
        }
    }
    async safeCloseTransport(transport) {
        try {
            await transport.close();
        }
        catch {
            // Ignore close errors during cleanup.
        }
    }
    applyNotificationHandlers(serverId, client) {
        const serverHandlers = this.notificationHandlers.get(serverId);
        if (!serverHandlers) {
            return;
        }
        for (const [schema] of serverHandlers) {
            client.setNotificationHandler(schema, this.createNotificationDispatcher(serverId, schema));
        }
    }
    createNotificationDispatcher(serverId, schema) {
        return (notification) => {
            const serverHandlers = this.notificationHandlers.get(serverId);
            const handlersForSchema = serverHandlers === null || serverHandlers === void 0 ? void 0 : serverHandlers.get(schema);
            if (!handlersForSchema || handlersForSchema.size === 0) {
                return;
            }
            for (const handler of handlersForSchema) {
                try {
                    handler(notification);
                }
                catch {
                    // Swallow individual handler errors to avoid breaking other listeners.
                }
            }
        };
    }
    applyElicitationHandler(serverId, client) {
        const serverSpecific = this.elicitationHandlers.get(serverId);
        if (serverSpecific) {
            client.setRequestHandler(ElicitRequestSchema, async (request) => serverSpecific(request.params));
            return;
        }
        if (this.elicitationCallback) {
            client.setRequestHandler(ElicitRequestSchema, async (request) => {
                var _a, _b, _c, _d;
                const reqId = `elicit_${Date.now()}_${Math.random()
                    .toString(36)
                    .slice(2, 9)}`;
                return await this.elicitationCallback({
                    requestId: reqId,
                    message: (_a = request.params) === null || _a === void 0 ? void 0 : _a.message,
                    schema: (_c = (_b = request.params) === null || _b === void 0 ? void 0 : _b.requestedSchema) !== null && _c !== void 0 ? _c : (_d = request.params) === null || _d === void 0 ? void 0 : _d.schema,
                });
            });
            return;
        }
    }
    async ensureConnected(serverId) {
        const state = this.clientStates.get(serverId);
        if (state === null || state === void 0 ? void 0 : state.client) {
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
        const timeout = (_a = state === null || state === void 0 ? void 0 : state.timeout) !== null && _a !== void 0 ? _a : (state ? this.getTimeout(state.config) : this.defaultTimeout);
        if (!options) {
            return { timeout };
        }
        if (options.timeout === undefined) {
            return { ...options, timeout };
        }
        return options;
    }
    buildCapabilities(config) {
        var _a;
        const capabilities = {
            ...this.defaultCapabilities,
            ...((_a = config.capabilities) !== null && _a !== void 0 ? _a : {}),
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
        }
        catch {
            return String(error);
        }
    }
    isMethodUnavailableError(error, method) {
        if (!(error instanceof Error)) {
            return false;
        }
        const message = error.message.toLowerCase();
        const methodTokens = new Set();
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
            "unimplemented",
        ];
        const indicatorMatch = indicators.some((indicator) => message.includes(indicator));
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
        return (_a = config.timeout) !== null && _a !== void 0 ? _a : this.defaultTimeout;
    }
    isStdioConfig(config) {
        return "command" in config;
    }
    getClientById(serverId) {
        const state = this.clientStates.get(serverId);
        if (!(state === null || state === void 0 ? void 0 : state.client)) {
            throw new Error(`MCP server "${serverId}" is not connected.`);
        }
        return state.client;
    }
}
