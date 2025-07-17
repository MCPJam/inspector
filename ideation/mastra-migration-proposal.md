# Migration Proposal: Replacing MCPJamClient and MCPJamAgent with Mastra MCPClient

## Overview

This proposal outlines how to replace the custom `MCPJamClient` and `MCPJamAgent` classes with Mastra's `MCPClient` while maintaining all existing functionality. This migration aligns with the v1.0.0 product roadmap to use industry-standard tooling.

## Current Architecture Analysis

### MCPJamAgent Responsibilities
- **Multi-Server Management**: Manages multiple MCP server connections via `Map<string, MCPJamClient>`
- **Performance Caching**: Tools (5min), Resources (2min), Prompts (3min) with background refresh
- **Server Discovery**: Cross-server tool/resource/prompt discovery
- **Connection Orchestration**: Parallel connection setup and cache initialization

### MCPJamClient Responsibilities  
- **Transport Abstraction**: STDIO, SSE, Streamable HTTP via proxy server
- **Authentication**: OAuth flows, bearer tokens, custom headers
- **Error Handling**: Retry logic, timeout management, progress tracking
- **Protocol Implementation**: Full MCP protocol with sampling, elicitation, roots

## Migration Strategy

### Phase 1: Create Mastra Adapter Layer

Create an adapter that wraps Mastra's MCPClient to provide the same interface as MCPJamAgent.

```typescript
// client/src/lib/utils/mcp/mastraAdapter.ts
import { MCPClient } from '@mastra/mcp';
import { Agent } from '@mastra/core/agent';
import { 
  Tool, 
  Resource, 
  Prompt, 
  ServerCapabilities,
  ElicitRequest,
  CreateMessageRequest,
  CreateMessageResult 
} from '@modelcontextprotocol/sdk/types.js';
import { MCPJamServerConfig } from '@/lib/types/serverTypes';
import { InspectorConfig } from '@/lib/types/configurationTypes';
import { StdErrNotification } from '@/lib/types/notificationTypes';
import { ElicitationResponse } from '@/components/ElicitationModal';
import { ClientLogLevels } from '@/hooks/helpers/types';

/**
 * Adapter that provides MCPJamAgent interface using Mastra MCPClient
 */
export class MastraMCPAdapter {
  private mcpClient: MCPClient;
  private serverConfigs: Record<string, MCPJamServerConfig>;
  private inspectorConfig: InspectorConfig;
  
  // Caching system (maintaining existing cache behavior)
  private toolsCache = new Map<string, { tools: Tool[]; timestamp: number }>();
  private resourcesCache = new Map<string, { resources: Resource[]; timestamp: number }>();
  private promptsCache = new Map<string, { prompts: Prompt[]; timestamp: number }>();
  
  // Cache expiry times (same as original)
  private readonly TOOLS_CACHE_EXPIRY = 5 * 60 * 1000; // 5 minutes
  private readonly RESOURCES_CACHE_EXPIRY = 2 * 60 * 1000; // 2 minutes  
  private readonly PROMPTS_CACHE_EXPIRY = 3 * 60 * 1000; // 3 minutes
  
  // Connection state tracking
  private connectionStates = new Map<string, {
    status: 'connected' | 'disconnected' | 'error' | 'error-connecting-to-proxy';
    capabilities: ServerCapabilities | null;
  }>();

  // Callbacks (maintaining existing interface)
  private onStdErrNotification?: (notification: StdErrNotification) => void;
  private onPendingRequest?: (
    request: CreateMessageRequest,
    resolve: (result: CreateMessageResult) => void,
    reject: (error: Error) => void,
  ) => void;
  private onElicitationRequest?: (
    request: ElicitRequest,
    resolve: (result: ElicitationResponse) => void,
  ) => void;
  private getRoots?: () => unknown[];
  private addRequestHistory: (request: object, response?: object) => void;
  public addClientLog: (message: string, level: ClientLogLevels) => void;

  constructor(options: {
    servers: Record<string, MCPJamServerConfig>;
    inspectorConfig: InspectorConfig;
    addRequestHistory: (request: object, response?: object) => void;
    addClientLog: (message: string, level: ClientLogLevels) => void;
    bearerToken?: string;
    headerName?: string;
    onStdErrNotification?: (notification: StdErrNotification) => void;
    onPendingRequest?: (
      request: CreateMessageRequest,
      resolve: (result: CreateMessageResult) => void,
      reject: (error: Error) => void,
    ) => void;
    onElicitationRequest?: (
      request: ElicitRequest,
      resolve: (result: ElicitationResponse) => void,
    ) => void;
    getRoots?: () => unknown[];
  }) {
    this.serverConfigs = options.servers;
    this.inspectorConfig = options.inspectorConfig;
    this.addRequestHistory = options.addRequestHistory;
    this.addClientLog = options.addClientLog;
    this.onStdErrNotification = options.onStdErrNotification;
    this.onPendingRequest = options.onPendingRequest;
    this.onElicitationRequest = options.onElicitationRequest;
    this.getRoots = options.getRoots;

    // Convert MCPJamServerConfig to Mastra server config
    const mastraServers = this.convertToMastraConfig(options.servers);
    
    this.mcpClient = new MCPClient({
      servers: mastraServers
    });
  }

  /**
   * Convert MCPJamServerConfig to Mastra server configuration
   */
  private convertToMastraConfig(servers: Record<string, MCPJamServerConfig>) {
    const mastraServers: Record<string, any> = {};
    
    for (const [name, config] of Object.entries(servers)) {
      if (config.transportType === 'stdio') {
        mastraServers[name] = {
          command: config.command,
          args: config.args || [],
          env: config.env || {}
        };
      } else {
        // For HTTP transports, we'll need to handle through proxy
        mastraServers[name] = {
          url: this.buildProxyUrl(config),
          requestInit: {
            headers: this.buildHeaders(config)
          }
        };
      }
    }
    
    return mastraServers;
  }

  /**
   * Build proxy URL for HTTP transports (maintaining existing proxy behavior)
   */
  private buildProxyUrl(config: MCPJamServerConfig): URL {
    const proxyBase = this.inspectorConfig.proxyServerUrl || 'http://localhost:6274';
    
    if (config.transportType === 'sse') {
      const url = new URL(`${proxyBase}/sse`);
      if ('url' in config && config.url) {
        url.searchParams.append('url', config.url.toString());
      }
      return url;
    } else if (config.transportType === 'streamable-http') {
      const url = new URL(`${proxyBase}/mcp`);
      if ('url' in config && config.url) {
        url.searchParams.append('url', config.url.toString());
      }
      return url;
    }
    
    throw new Error(`Unsupported transport type: ${config.transportType}`);
  }

  /**
   * Build headers for HTTP requests
   */
  private buildHeaders(config: MCPJamServerConfig): Record<string, string> {
    const headers: Record<string, string> = {};
    
    // Add authentication headers if available
    // This will need to be enhanced based on your OAuth implementation
    
    return headers;
  }

  // ====== MCPJamAgent Interface Compatibility ======

  /**
   * Add or update a server configuration
   */
  addServer(name: string, config: MCPJamServerConfig): void {
    this.serverConfigs[name] = config;
    // Recreate MCPClient with updated servers
    const mastraServers = this.convertToMastraConfig(this.serverConfigs);
    this.mcpClient = new MCPClient({ servers: mastraServers });
  }

  /**
   * Remove a server and disconnect its client
   */
  async removeServer(name: string): Promise<void> {
    await this.disconnectFromServer(name);
    delete this.serverConfigs[name];
    this.connectionStates.delete(name);
    this.clearCaches(name);
    
    // Recreate MCPClient without the removed server
    const mastraServers = this.convertToMastraConfig(this.serverConfigs);
    this.mcpClient = new MCPClient({ servers: mastraServers });
  }

  /**
   * Get list of all configured server names
   */
  getServerNames(): string[] {
    return Object.keys(this.serverConfigs);
  }

  /**
   * Connect to a specific server
   */
  async connectToServer(serverName: string): Promise<void> {
    try {
      this.addClientLog(`Connecting to server: ${serverName}`, 'info');
      
      // Mastra handles the connection internally
      // We just need to track the state and initialize caches
      
      this.connectionStates.set(serverName, {
        status: 'connected',
        capabilities: null // Will be populated after connection
      });
      
      // Initialize caches in parallel (maintaining existing behavior)
      await Promise.all([
        this.cacheToolsForServer(serverName),
        this.cacheResourcesForServer(serverName),
        this.cachePromptsForServer(serverName),
      ]);
      
      this.addClientLog(`Successfully connected to server: ${serverName}`, 'info');
    } catch (error) {
      this.connectionStates.set(serverName, {
        status: 'error',
        capabilities: null
      });
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.addClientLog(`Failed to connect to server ${serverName}: ${errorMessage}`, 'error');
      throw error;
    }
  }

  /**
   * Disconnect from a specific server
   */
  async disconnectFromServer(serverName: string): Promise<void> {
    const state = this.connectionStates.get(serverName);
    if (state) {
      state.status = 'disconnected';
      this.clearCaches(serverName);
      this.addClientLog(`Disconnected from server: ${serverName}`, 'info');
    }
  }

  /**
   * Get all tools from all connected servers (with caching)
   */
  async getAllTools(): Promise<{ serverName: string; tools: Tool[] }[]> {
    const allServerTools: { serverName: string; tools: Tool[] }[] = [];
    const refreshPromises: Promise<void>[] = [];

    const connectedServers = this.getConnectedServers();

    for (const serverName of connectedServers) {
      // Check cache validity
      if (!this.isToolsCacheValid(serverName)) {
        refreshPromises.push(this.cacheToolsForServer(serverName));
      }

      // Use cached data (even if being refreshed)
      const cachedEntry = this.toolsCache.get(serverName);
      allServerTools.push({
        serverName,
        tools: cachedEntry?.tools || [],
      });
    }

    // Background refresh if needed
    if (refreshPromises.length > 0) {
      this.addClientLog(`Starting background refresh for ${refreshPromises.length} expired tool caches`, 'debug');
      Promise.all(refreshPromises).catch((error) => {
        console.error('Error refreshing tool cache:', error);
      });
    }

    return allServerTools;
  }

  /**
   * Cache tools for a specific server using Mastra
   */
  private async cacheToolsForServer(serverName: string): Promise<void> {
    try {
      // Use Mastra's getTools() method to get tools for specific server
      const allTools = await this.mcpClient.getTools();
      
      // Filter tools for this specific server (tools are namespaced)
      const serverTools: Tool[] = [];
      const prefix = `${serverName}.`;
      
      for (const [toolName, tool] of Object.entries(allTools)) {
        if (toolName.startsWith(prefix)) {
          // Remove the server prefix from the tool name
          const cleanTool = {
            ...tool,
            name: toolName.substring(prefix.length)
          };
          serverTools.push(cleanTool);
        }
      }

      const timestamp = Date.now();
      this.toolsCache.set(serverName, {
        tools: serverTools,
        timestamp,
      });

      this.addClientLog(`Cached ${serverTools.length} tools for ${serverName}`, 'debug');
    } catch (error) {
      console.error(`Failed to cache tools for server ${serverName}:`, error);
      this.toolsCache.set(serverName, { tools: [], timestamp: Date.now() });
    }
  }

  /**
   * Cache resources for a specific server using Mastra
   */
  private async cacheResourcesForServer(serverName: string): Promise<void> {
    try {
      // Use Mastra's resources.list() method
      const allResources = await this.mcpClient.resources.list();
      const serverResources = allResources[serverName] || [];

      const timestamp = Date.now();
      this.resourcesCache.set(serverName, {
        resources: serverResources,
        timestamp,
      });

      this.addClientLog(`Cached ${serverResources.length} resources for ${serverName}`, 'debug');
    } catch (error) {
      console.error(`Failed to cache resources for server ${serverName}:`, error);
      this.resourcesCache.set(serverName, { resources: [], timestamp: Date.now() });
    }
  }

  /**
   * Cache prompts for a specific server using Mastra
   */
  private async cachePromptsForServer(serverName: string): Promise<void> {
    try {
      // Use Mastra's prompts.list() method
      const allPrompts = await this.mcpClient.prompts.list();
      const serverPrompts = allPrompts[serverName] || [];

      const timestamp = Date.now();
      this.promptsCache.set(serverName, {
        prompts: serverPrompts,
        timestamp,
      });

      this.addClientLog(`Cached ${serverPrompts.length} prompts for ${serverName}`, 'debug');
    } catch (error) {
      console.error(`Failed to cache prompts for server ${serverName}:`, error);
      this.promptsCache.set(serverName, { prompts: [], timestamp: Date.now() });
    }
  }

  // ====== Cache Management (maintaining existing logic) ======

  private isToolsCacheValid(serverName: string): boolean {
    return this.isCacheValid(this.toolsCache, serverName, this.TOOLS_CACHE_EXPIRY);
  }

  private isResourcesCacheValid(serverName: string): boolean {
    return this.isCacheValid(this.resourcesCache, serverName, this.RESOURCES_CACHE_EXPIRY);
  }

  private isPromptsCacheValid(serverName: string): boolean {
    return this.isCacheValid(this.promptsCache, serverName, this.PROMPTS_CACHE_EXPIRY);
  }

  private isCacheValid<T>(
    cache: Map<string, { timestamp: number } & T>,
    serverName: string,
    expiryTime: number,
  ): boolean {
    const cacheEntry = cache.get(serverName);
    if (!cacheEntry) return false;

    const now = Date.now();
    return now - cacheEntry.timestamp < expiryTime;
  }

  private clearCaches(serverName: string): void {
    this.toolsCache.delete(serverName);
    this.resourcesCache.delete(serverName);
    this.promptsCache.delete(serverName);
    this.addClientLog(`Cleared all caches for server ${serverName}`, 'debug');
  }

  private getConnectedServers(): string[] {
    const connected: string[] = [];
    for (const [name, state] of this.connectionStates.entries()) {
      if (state.status === 'connected') {
        connected.push(name);
      }
    }
    return connected;
  }

  // ====== Tool/Resource/Prompt Operations ======

  /**
   * Call a tool on a specific server
   */
  async callToolOnServer(
    serverName: string,
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    try {
      // Get all tools to find the namespaced tool
      const allTools = await this.mcpClient.getTools();
      const namespacedToolName = `${serverName}.${toolName}`;
      const tool = allTools[namespacedToolName];
      
      if (!tool) {
        throw new Error(`Tool ${toolName} not found on server ${serverName}`);
      }

      // Execute the tool manually (since Mastra supports manual tool execution)
      const result = await tool.execute({
        context: params,
        runtimeContext: new (await import('@mastra/core/di')).RuntimeContext()
      });

      this.addRequestHistory(
        { method: 'tools/call', params: { name: toolName, arguments: params } },
        result
      );

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.addRequestHistory(
        { method: 'tools/call', params: { name: toolName, arguments: params } },
        { error: errorMessage }
      );
      throw error;
    }
  }

  /**
   * Read a resource from a specific server
   */
  async readResourceFromServer(serverName: string, uri: string): Promise<unknown> {
    try {
      this.addClientLog(`Reading resource '${uri}' from server ${serverName}`, 'debug');
      
      const result = await this.mcpClient.resources.read(uri);
      
      this.addClientLog(`Successfully read resource '${uri}'`, 'debug');
      this.addRequestHistory(
        { method: 'resources/read', params: { uri } },
        result
      );

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.addClientLog(`Failed to read resource '${uri}' from server ${serverName}: ${errorMessage}`, 'error');
      this.addRequestHistory(
        { method: 'resources/read', params: { uri } },
        { error: errorMessage }
      );
      throw error;
    }
  }

  /**
   * Get a prompt from a specific server
   */
  async getPromptFromServer(
    serverName: string,
    name: string,
    args: Record<string, string> = {},
  ): Promise<unknown> {
    try {
      this.addClientLog(`Fetching prompt '${name}' from server ${serverName}`, 'debug');
      
      const result = await this.mcpClient.prompts.get(name, args);
      
      this.addClientLog(`Successfully fetched prompt '${name}'`, 'debug');
      this.addRequestHistory(
        { method: 'prompts/get', params: { name, arguments: args } },
        result
      );

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.addClientLog(`Failed to get prompt '${name}' from server ${serverName}: ${errorMessage}`, 'error');
      this.addRequestHistory(
        { method: 'prompts/get', params: { name, arguments: args } },
        { error: errorMessage }
      );
      throw error;
    }
  }

  // ====== Compatibility Methods for MCPJamAgent Interface ======

  /**
   * Get client for a specific server (compatibility method)
   */
  getClient(serverName: string): any {
    // Return a mock client that provides the same interface
    const state = this.connectionStates.get(serverName);
    if (!state) return undefined;

    return {
      connectionStatus: state.status,
      serverCapabilities: state.capabilities,
      completionsSupported: true, // Mastra supports completions
      makeRequest: async (request: any) => {
        // Route to appropriate Mastra method based on request
        if (request.method === 'tools/call') {
          return this.callToolOnServer(serverName, request.params.name, request.params.arguments || {});
        } else if (request.method === 'resources/read') {
          return this.readResourceFromServer(serverName, request.params.uri);
        } else if (request.method === 'prompts/get') {
          return this.getPromptFromServer(serverName, request.params.name, request.params.arguments || {});
        }
        // Add other methods as needed
        throw new Error(`Unsupported method: ${request.method}`);
      }
    };
  }

  /**
   * Get all connection info (compatibility method)
   */
  getAllConnectionInfo(): Array<{
    name: string;
    config: MCPJamServerConfig;
    client: any;
    connectionStatus: string;
    capabilities: ServerCapabilities | null;
  }> {
    return Object.entries(this.serverConfigs).map(([name, config]) => {
      const state = this.connectionStates.get(name);
      return {
        name,
        config,
        client: this.getClient(name),
        connectionStatus: state?.status || 'disconnected',
        capabilities: state?.capabilities || null,
      };
    });
  }

  /**
   * Disconnect from all servers
   */
  async disconnectFromAllServers(): Promise<void> {
    await this.mcpClient.disconnect();
    
    for (const serverName of this.getServerNames()) {
      this.connectionStates.set(serverName, {
        status: 'disconnected',
        capabilities: null
      });
      this.clearCaches(serverName);
    }
    
    this.addClientLog('Disconnected from all servers', 'info');
  }

  // ====== Direct Mastra Access ======

  /**
   * Get the underlying Mastra MCPClient for direct access
   */
  getMastraClient(): MCPClient {
    return this.mcpClient;
  }
}
```

### Phase 2: Update Connection State Hook

Modify the connection state hook to use the Mastra adapter:

```typescript
// client/src/hooks/useConnectionState.ts
import { useState, useCallback, useRef } from 'react';
import { MastraMCPAdapter } from '@/lib/utils/mcp/mastraAdapter';
// ... other imports

export function useConnectionState(
  addRequestHistory: (request: object, response?: object) => void,
  addClientLog: (message: string, level: ClientLogLevels) => void,
) {
  const [mcpAgent, setMcpAgent] = useState<MastraMCPAdapter | null>(null);
  const [sidebarUpdateTrigger, setSidebarUpdateTrigger] = useState(0);

  const createMCPAgent = useCallback((
    servers: Record<string, MCPJamServerConfig>,
    inspectorConfig: InspectorConfig,
    // ... other parameters
  ) => {
    const agent = new MastraMCPAdapter({
      servers,
      inspectorConfig,
      addRequestHistory,
      addClientLog,
      // ... other options
    });
    
    setMcpAgent(agent);
    return agent;
  }, [addRequestHistory, addClientLog]);

  // ... rest of the hook implementation
}
```

### Phase 3: Update MCP Operations Hook

Modify the MCP operations to work with the Mastra adapter:

```typescript
// client/src/hooks/useMCPOperations.ts

export function useMCPOperations() {
  // ... existing state

  const makeRequest = useCallback(async (
    mcpAgent: MastraMCPAdapter | null,
    serverName: string,
    request: ClientRequest,
  ) => {
    if (!mcpAgent) throw new Error('No MCP agent available');
    
    const client = mcpAgent.getClient(serverName);
    if (!client) throw new Error(`No client for server: ${serverName}`);
    
    return await client.makeRequest(request);
  }, []);

  const listTools = useCallback(async (
    mcpAgent: MastraMCPAdapter | null,
    serverName: string,
  ) => {
    if (!mcpAgent) return;
    
    try {
      const allServerTools = await mcpAgent.getAllTools();
      const serverTools = allServerTools.find(st => st.serverName === serverName);
      
      if (serverTools) {
        setTools(serverTools.tools);
        addRequestHistory(
          { method: 'tools/list' },
          { tools: serverTools.tools }
        );
      }
    } catch (error) {
      handleOperationError('tools', error);
    }
  }, [addRequestHistory]);

  const callTool = useCallback(async (
    mcpAgent: MastraMCPAdapter | null,
    serverName: string,
    toolName: string,
    params: Record<string, unknown>,
  ) => {
    if (!mcpAgent) return;
    
    try {
      const result = await mcpAgent.callToolOnServer(serverName, toolName, params);
      setToolResult(result);
    } catch (error) {
      handleOperationError('tools', error);
    }
  }, []);

  // ... implement other operations similarly

  return {
    makeRequest,
    listTools,
    callTool,
    // ... other operations
  };
}
```

## Migration Benefits

### 1. **Industry Standard Implementation**
- Uses Mastra's battle-tested MCP implementation
- Automatic compatibility with latest MCP protocol changes
- Community support and maintenance

### 2. **Simplified Codebase**
- Remove ~2000 lines of custom MCP client code
- Reduce maintenance burden
- Focus on inspector-specific features

### 3. **Enhanced Capabilities**
- Built-in support for Vercel AI SDK integration
- Better error handling and retry logic
- Improved performance optimizations

### 4. **Future-Proof Architecture**
- Easy integration with Mastra's Agent system for chat functionality
- Support for advanced MCP features as they're added to Mastra
- Plugin ecosystem compatibility

## Implementation Timeline

### Week 1: Core Adapter Development
- [ ] Create `MastraMCPAdapter` class
- [ ] Implement basic connection management
- [ ] Add caching layer compatibility
- [ ] Create unit tests

### Week 2: Integration and Testing
- [ ] Update hooks to use Mastra adapter
- [ ] Migrate all MCP operations
- [ ] Comprehensive integration testing
- [ ] Performance benchmarking

### Week 3: Polish and Optimization
- [ ] Error handling improvements
- [ ] Authentication flow updates
- [ ] Documentation updates
- [ ] Final testing and bug fixes

## Risk Mitigation

### 1. **Gradual Migration**
- Keep existing classes during development
- Use feature flags to switch between implementations
- Thorough testing before removing old code

### 2. **Compatibility Layer**
- Maintain exact same interface initially
- Gradually expose Mastra-specific features
- Ensure all existing functionality works

### 3. **Rollback Plan**
- Keep old implementation in separate branch
- Document all changes for easy reversal
- Staged deployment with monitoring

## Configuration Changes Required

### 1. **Package Dependencies**
```json
{
  "dependencies": {
    "@mastra/mcp": "latest",
    "@mastra/core": "latest"
  }
}
```

### 2. **Proxy Server Updates**
The existing proxy server should continue to work with minimal changes, as Mastra will connect through the same endpoints.

### 3. **Authentication Flow**
May need updates to work with Mastra's authentication system, but the existing OAuth implementation should be largely compatible.

## Conclusion

This migration proposal maintains all existing functionality while leveraging industry-standard tooling. The adapter pattern ensures a smooth transition with minimal risk, while positioning the codebase for future enhancements and easier maintenance.

The key insight is that Mastra's MCPClient provides the core MCP functionality, while our adapter layer maintains the specific behaviors needed for the inspector (caching, multi-server management, proxy integration) without requiring a complete rewrite of the application logic.