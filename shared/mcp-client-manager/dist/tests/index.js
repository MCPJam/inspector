import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { CallToolResultSchema, ResourceListChangedNotificationSchema, ResourceUpdatedNotificationSchema, PromptListChangedNotificationSchema, } from '@modelcontextprotocol/sdk/types.js';
export class MCPClientManager {
    constructor(servers = {}, options = {}) {
        var _a, _b, _c;
        this.serverConfigs = new Map();
        this.clientStates = new Map();
        this.notificationHandlers = new Map();
        this.defaultClientVersion = (_a = options.defaultClientVersion) !== null && _a !== void 0 ? _a : '1.0.0';
        this.defaultCapabilities = { ...((_b = options.defaultCapabilities) !== null && _b !== void 0 ? _b : {}) };
        this.defaultTimeout = (_c = options.defaultTimeout) !== null && _c !== void 0 ? _c : DEFAULT_REQUEST_TIMEOUT_MSEC;
        for (const [name, config] of Object.entries(servers)) {
            this.registerServer(name, config);
        }
    }
    registerServer(name, config) {
        const serverName = name.trim();
        if (!serverName) {
            throw new Error('Server name must be a non-empty string.');
        }
        const state = this.clientStates.get(serverName);
        if (state === null || state === void 0 ? void 0 : state.connectionPromise) {
            throw new Error(`Server "${serverName}" is currently connecting. Disconnect before reconfiguring.`);
        }
        if (state === null || state === void 0 ? void 0 : state.client) {
            throw new Error(`Server "${serverName}" is already connected. Disconnect before reconfiguring.`);
        }
        this.serverConfigs.set(serverName, config);
        this.clientStates.set(serverName, {
            config,
            timeout: this.getTimeout(config),
        });
    }
    unregisterServer(name) {
        const serverName = name.trim();
        const state = this.clientStates.get(serverName);
        if ((state === null || state === void 0 ? void 0 : state.client) || (state === null || state === void 0 ? void 0 : state.connectionPromise)) {
            throw new Error(`Cannot unregister server "${serverName}" while it is connected. Disconnect first.`);
        }
        this.serverConfigs.delete(serverName);
        this.clientStates.delete(serverName);
        this.notificationHandlers.delete(serverName);
    }
    listServers() {
        return Array.from(this.serverConfigs.keys());
    }
    hasServer(name) {
        return this.serverConfigs.has(name.trim());
    }
    async connectToServer(name) {
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
    async disconnectServer(name) {
        var _a, _b;
        const serverName = name.trim();
        const state = this.clientStates.get(serverName);
        if (!(state === null || state === void 0 ? void 0 : state.client)) {
            (_a = state === null || state === void 0 ? void 0 : state.connectionPromise) === null || _a === void 0 ? void 0 : _a.catch(() => undefined);
            state ? (state.connectionPromise = undefined) : undefined;
            return;
        }
        try {
            await state.client.close();
            await ((_b = state.transport) === null || _b === void 0 ? void 0 : _b.close());
        }
        finally {
            this.resetState(serverName, { preserveConfig: true });
        }
    }
    async disconnectAll() {
        await Promise.all(this.listServers().map(name => this.disconnectServer(name)));
    }
    async listTools(name, params, options) {
        const client = await this.connectToServer(name);
        return client.listTools(params, this.withTimeout(name, options));
    }
    async executeTool(name, toolName, args = {}, options) {
        const client = await this.connectToServer(name);
        return client.callTool({
            name: toolName,
            arguments: args,
        }, CallToolResultSchema, this.withTimeout(name, options));
    }
    async listResources(name, params, options) {
        const client = await this.connectToServer(name);
        return client.listResources(params, this.withTimeout(name, options));
    }
    async readResource(name, params, options) {
        const client = await this.connectToServer(name);
        return client.readResource(params, this.withTimeout(name, options));
    }
    async subscribeResource(name, params, options) {
        const client = await this.connectToServer(name);
        return client.subscribeResource(params, this.withTimeout(name, options));
    }
    async unsubscribeResource(name, params, options) {
        const client = await this.connectToServer(name);
        return client.unsubscribeResource(params, this.withTimeout(name, options));
    }
    async listResourceTemplates(name, params, options) {
        const client = await this.connectToServer(name);
        return client.listResourceTemplates(params, this.withTimeout(name, options));
    }
    async listPrompts(name, params, options) {
        const client = await this.connectToServer(name);
        return client.listPrompts(params, this.withTimeout(name, options));
    }
    async getPrompt(name, params, options) {
        const client = await this.connectToServer(name);
        return client.getPrompt(params, this.withTimeout(name, options));
    }
    getSessionId(name) {
        const state = this.clientStates.get(name.trim());
        if (!(state === null || state === void 0 ? void 0 : state.transport)) {
            return undefined;
        }
        if (state.transport instanceof StreamableHTTPClientTransport) {
            return state.transport.sessionId;
        }
        return undefined;
    }
    addNotificationHandler(name, schema, handler) {
        var _a, _b;
        const serverName = name.trim();
        const handlers = (_a = this.notificationHandlers.get(serverName)) !== null && _a !== void 0 ? _a : [];
        handlers.push({ schema, handler });
        this.notificationHandlers.set(serverName, handlers);
        const client = (_b = this.clientStates.get(serverName)) === null || _b === void 0 ? void 0 : _b.client;
        if (client) {
            client.setNotificationHandler(schema, handler);
        }
    }
    onResourceListChanged(name, handler) {
        this.addNotificationHandler(name, ResourceListChangedNotificationSchema, handler);
    }
    onResourceUpdated(name, handler) {
        this.addNotificationHandler(name, ResourceUpdatedNotificationSchema, handler);
    }
    onPromptListChanged(name, handler) {
        this.addNotificationHandler(name, PromptListChangedNotificationSchema, handler);
    }
    getClient(name) {
        var _a;
        return (_a = this.clientStates.get(name.trim())) === null || _a === void 0 ? void 0 : _a.client;
    }
    async createClientAndConnect(serverName, config) {
        var _a;
        const capabilities = this.buildCapabilities(config);
        const client = new Client({
            name: serverName,
            version: (_a = config.version) !== null && _a !== void 0 ? _a : this.defaultClientVersion,
        }, {
            capabilities,
        });
        this.applyNotificationHandlers(serverName, client);
        if (config.onError) {
            client.onerror = error => {
                var _a;
                (_a = config.onError) === null || _a === void 0 ? void 0 : _a.call(config, error);
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
    async connectViaHttp(serverName, client, config, timeout) {
        var _a;
        const preferSSE = (_a = config.preferSSE) !== null && _a !== void 0 ? _a : config.url.pathname.endsWith('/sse');
        let streamableError;
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
                : '';
            throw new Error(`Failed to connect to MCP server "${serverName}" using HTTP transports.${streamableMessage} SSE error: ${this.formatError(error)}.`);
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
    applyNotificationHandlers(serverName, client) {
        const handlers = this.notificationHandlers.get(serverName);
        if (!handlers) {
            return;
        }
        for (const { schema, handler } of handlers) {
            client.setNotificationHandler(schema, handler);
        }
    }
    ensureState(name, config) {
        const existing = this.clientStates.get(name);
        if (existing) {
            existing.config = config;
            existing.timeout = this.getTimeout(config);
            return existing;
        }
        const state = {
            config,
            timeout: this.getTimeout(config),
        };
        this.clientStates.set(name, state);
        return state;
    }
    resetState(name, options) {
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
    setTransport(name, transport) {
        const state = this.clientStates.get(name);
        if (!state) {
            return;
        }
        state.transport = transport;
    }
    withTimeout(name, options) {
        var _a, _b;
        const timeout = (_b = (_a = this.clientStates.get(name.trim())) === null || _a === void 0 ? void 0 : _a.timeout) !== null && _b !== void 0 ? _b : this.defaultTimeout;
        if (!options) {
            return { timeout };
        }
        if (options.timeout === undefined) {
            return { ...options, timeout };
        }
        return options;
    }
    getServerConfig(name) {
        const config = this.serverConfigs.get(name);
        if (!config) {
            throw new Error(`Unknown MCP server "${name}".`);
        }
        return config;
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
    getTimeout(config) {
        var _a;
        return (_a = config.timeout) !== null && _a !== void 0 ? _a : this.defaultTimeout;
    }
    isStdioConfig(config) {
        return 'command' in config;
    }
}
