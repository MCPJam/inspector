# Complete Mastra Replacement Plan

## Overview

This plan completely replaces MCPJamClient and MCPJamAgent with native Mastra MCPClient and Agent, eliminating all custom MCP implementation code. We'll rebuild the system using Mastra's native patterns.

## New Architecture

### Core Components

1. **Mastra MCPClient** - Direct replacement for MCPJamAgent
2. **Mastra Agent** - For chat functionality 
3. **Server Configuration Manager** - Lightweight config management
4. **Connection State Manager** - Simple connection tracking

## Implementation Plan

### 1. Replace MCPJamAgent with Mastra MCPClient

```typescript
// client/src/lib/mcp/mastraClient.ts
import { MCPClient } from '@mastra/mcp';
import { MCPJamServerConfig } from '@/lib/types/serverTypes';

/**
 * Direct Mastra MCPClient wrapper for the inspector
 */
export class InspectorMCPClient {
  private mcpClient: MCPClient | null = null;
  private serverConfigs: Record<string, MCPJamServerConfig> = {};
  private isConnected = false;

  constructor() {}

  /**
   * Configure and connect to servers
   */
  async configure(servers: Record<string, MCPJamServerConfig>): Promise<void> {
    this.serverConfigs = servers;
    
    // Convert to Mastra server configuration
    const mastraServers = this.convertToMastraConfig(servers);
    
    // Create new Mastra client
    this.mcpClient = new MCPClient({
      servers: mastraServers
    });

    // Connect to all servers
    await this.mcpClient.connect();
    this.isConnected = true;
  }

  /**
   * Convert MCPJamServerConfig to Mastra format
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
        // For HTTP servers, connect directly (no proxy needed with Mastra)
        if ('url' in config && config.url) {
          mastraServers[name] = {
            url: config.url,
            requestInit: {
              headers: this.buildAuthHeaders(config)
            }
          };
        }
      }
    }

    return mastraServers;
  }

  /**
   * Build authentication headers
   */
  private buildAuthHeaders(config: MCPJamServerConfig): Record<string, string> {
    const headers: Record<string, string> = {};
    
    // Add bearer token if available
    if ('bearerToken' in config && config.bearerToken) {
      headers['Authorization'] = `Bearer ${config.bearerToken}`;
    }
    
    return headers;
  }

  /**
   * Get all tools from all servers (Mastra handles caching internally)
   */
  async getTools(): Promise<Record<string, any>> {
    if (!this.mcpClient) throw new Error('Client not configured');
    return await this.mcpClient.getTools();
  }

  /**
   * Get toolsets for dynamic configuration
   */
  async getToolsets(): Promise<Record<string, Record<string, any>>> {
    if (!this.mcpClient) throw new Error('Client not configured');
    return await this.mcpClient.getToolsets();
  }

  /**
   * List all resources
   */
  async listResources(): Promise<Record<string, any[]>> {
    if (!this.mcpClient) throw new Error('Client not configured');
    return await this.mcpClient.resources.list();
  }

  /**
   * Read a specific resource
   */
  async readResource(uri: string): Promise<any> {
    if (!this.mcpClient) throw new Error('Client not configured');
    return await this.mcpClient.resources.read(uri);
  }

  /**
   * List all prompts
   */
  async listPrompts(): Promise<Record<string, any[]>> {
    if (!this.mcpClient) throw new Error('Client not configured');
    return await this.mcpClient.prompts.list();
  }

  /**
   * Get a specific prompt
   */
  async getPrompt(name: string, args?: Record<string, any>): Promise<any> {
    if (!this.mcpClient) throw new Error('Client not configured');
    return await this.mcpClient.prompts.get(name, args);
  }

  /**
   * Call a tool manually
   */
  async callTool(toolName: string, params: Record<string, any>): Promise<any> {
    if (!this.mcpClient) throw new Error('Client not configured');
    
    const tools = await this.getTools();
    const tool = tools[toolName];
    
    if (!tool) {
      throw new Error(`Tool ${toolName} not found`);
    }

    // Execute tool manually
    const { RuntimeContext } = await import('@mastra/core/di');
    return await tool.execute({
      context: params,
      runtimeContext: new RuntimeContext()
    });
  }

  /**
   * Get server names
   */
  getServerNames(): string[] {
    return Object.keys(this.serverConfigs);
  }

  /**
   * Check if connected
   */
  isClientConnected(): boolean {
    return this.isConnected;
  }

  /**
   * Disconnect from all servers
   */
  async disconnect(): Promise<void> {
    if (this.mcpClient) {
      await this.mcpClient.disconnect();
      this.isConnected = false;
    }
  }

  /**
   * Add a new server configuration
   */
  async addServer(name: string, config: MCPJamServerConfig): Promise<void> {
    this.serverConfigs[name] = config;
    await this.configure(this.serverConfigs);
  }

  /**
   * Remove a server
   */
  async removeServer(name: string): Promise<void> {
    delete this.serverConfigs[name];
    await this.configure(this.serverConfigs);
  }

  /**
   * Get underlying Mastra client
   */
  getMastraClient(): MCPClient | null {
    return this.mcpClient;
  }
}
```

### 2. Simplified Connection State Hook

```typescript
// client/src/hooks/useConnectionState.ts
import { useState, useCallback } from 'react';
import { InspectorMCPClient } from '@/lib/mcp/mastraClient';
import { MCPJamServerConfig } from '@/lib/types/serverTypes';

export function useConnectionState() {
  const [mcpClient, setMcpClient] = useState<InspectorMCPClient | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const createClient = useCallback(() => {
    const client = new InspectorMCPClient();
    setMcpClient(client);
    return client;
  }, []);

  const connectToServers = useCallback(async (servers: Record<string, MCPJamServerConfig>) => {
    try {
      setConnectionError(null);
      
      let client = mcpClient;
      if (!client) {
        client = createClient();
      }

      await client.configure(servers);
      setIsConnected(true);
      
      return client;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setConnectionError(errorMessage);
      setIsConnected(false);
      throw error;
    }
  }, [mcpClient, createClient]);

  const disconnect = useCallback(async () => {
    if (mcpClient) {
      await mcpClient.disconnect();
      setIsConnected(false);
    }
  }, [mcpClient]);

  const addServer = useCallback(async (name: string, config: MCPJamServerConfig) => {
    if (!mcpClient) throw new Error('No client available');
    await mcpClient.addServer(name, config);
  }, [mcpClient]);

  const removeServer = useCallback(async (name: string) => {
    if (!mcpClient) throw new Error('No client available');
    await mcpClient.removeServer(name);
  }, [mcpClient]);

  return {
    mcpClient,
    isConnected,
    connectionError,
    connectToServers,
    disconnect,
    addServer,
    removeServer,
    createClient,
  };
}
```

### 3. Simplified MCP Operations Hook

```typescript
// client/src/hooks/useMCPOperations.ts
import { useState, useCallback } from 'react';
import { Tool, Resource, Prompt } from '@modelcontextprotocol/sdk/types.js';
import { InspectorMCPClient } from '@/lib/mcp/mastraClient';

export function useMCPOperations() {
  // State for current operations
  const [tools, setTools] = useState<Tool[]>([]);
  const [selectedTool, setSelectedTool] = useState<Tool | null>(null);
  const [toolResult, setToolResult] = useState<any>(null);

  const [resources, setResources] = useState<Resource[]>([]);
  const [selectedResource, setSelectedResource] = useState<Resource | null>(null);
  const [resourceContent, setResourceContent] = useState<any>(null);

  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [selectedPrompt, setSelectedPrompt] = useState<Prompt | null>(null);
  const [promptContent, setPromptContent] = useState<any>(null);

  const [errors, setErrors] = useState<Record<string, string>>({});

  // Helper to clear errors
  const clearError = useCallback((operation: string) => {
    setErrors(prev => {
      const newErrors = { ...prev };
      delete newErrors[operation];
      return newErrors;
    });
  }, []);

  // Helper to set errors
  const setError = useCallback((operation: string, error: string) => {
    setErrors(prev => ({ ...prev, [operation]: error }));
  }, []);

  // Tool operations
  const listTools = useCallback(async (client: InspectorMCPClient, serverName?: string) => {
    try {
      clearError('tools');
      const allTools = await client.getTools();
      
      // Convert to array and filter by server if specified
      const toolsArray: Tool[] = [];
      for (const [toolName, tool] of Object.entries(allTools)) {
        if (!serverName || toolName.startsWith(`${serverName}.`)) {
          toolsArray.push({
            name: serverName ? toolName.replace(`${serverName}.`, '') : toolName,
            description: tool.description || '',
            inputSchema: tool.inputSchema || {}
          });
        }
      }
      
      setTools(toolsArray);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setError('tools', errorMessage);
    }
  }, [clearError, setError]);

  const callTool = useCallback(async (
    client: InspectorMCPClient,
    serverName: string,
    toolName: string,
    params: Record<string, unknown>
  ) => {
    try {
      clearError('tools');
      setToolResult(null);
      
      // Use namespaced tool name for Mastra
      const namespacedToolName = `${serverName}.${toolName}`;
      const result = await client.callTool(namespacedToolName, params);
      
      setToolResult(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setError('tools', errorMessage);
    }
  }, [clearError, setError]);

  // Resource operations
  const listResources = useCallback(async (client: InspectorMCPClient, serverName?: string) => {
    try {
      clearError('resources');
      const allResources = await client.listResources();
      
      // Flatten resources and filter by server if specified
      const resourcesArray: Resource[] = [];
      for (const [server, serverResources] of Object.entries(allResources)) {
        if (!serverName || server === serverName) {
          resourcesArray.push(...serverResources);
        }
      }
      
      setResources(resourcesArray);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setError('resources', errorMessage);
    }
  }, [clearError, setError]);

  const readResource = useCallback(async (
    client: InspectorMCPClient,
    _serverName: string,
    uri: string
  ) => {
    try {
      clearError('resources');
      const content = await client.readResource(uri);
      setResourceContent(content);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setError('resources', errorMessage);
    }
  }, [clearError, setError]);

  // Prompt operations
  const listPrompts = useCallback(async (client: InspectorMCPClient, serverName?: string) => {
    try {
      clearError('prompts');
      const allPrompts = await client.listPrompts();
      
      // Flatten prompts and filter by server if specified
      const promptsArray: Prompt[] = [];
      for (const [server, serverPrompts] of Object.entries(allPrompts)) {
        if (!serverName || server === serverName) {
          promptsArray.push(...serverPrompts);
        }
      }
      
      setPrompts(promptsArray);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setError('prompts', errorMessage);
    }
  }, [clearError, setError]);

  const getPrompt = useCallback(async (
    client: InspectorMCPClient,
    _serverName: string,
    name: string,
    args: Record<string, string>
  ) => {
    try {
      clearError('prompts');
      const content = await client.getPrompt(name, args);
      setPromptContent(content);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setError('prompts', errorMessage);
    }
  }, [clearError, setError]);

  return {
    // Tool state and operations
    tools,
    selectedTool,
    toolResult,
    setTools,
    setSelectedTool,
    setToolResult,
    listTools,
    callTool,

    // Resource state and operations
    resources,
    selectedResource,
    resourceContent,
    setResources,
    setSelectedResource,
    setResourceContent,
    listResources,
    readResource,

    // Prompt state and operations
    prompts,
    selectedPrompt,
    promptContent,
    setPrompts,
    setSelectedPrompt,
    setPromptContent,
    listPrompts,
    getPrompt,

    // Error handling
    errors,
    clearError,
  };
}
```

### 4. Simplified Server Management Hook

```typescript
// client/src/hooks/useServerManagement.ts
import { useCallback } from 'react';
import { MCPJamServerConfig } from '@/lib/types/serverTypes';
import { InspectorMCPClient } from '@/lib/mcp/mastraClient';

export function useServerManagement(
  serverState: any,
  connectionState: any,
  configState: any,
) {
  const handleConnectServer = useCallback(async (serverName: string) => {
    try {
      const serverConfig = serverState.serverConfigs[serverName];
      if (!serverConfig) {
        throw new Error(`Server ${serverName} not found`);
      }

      // Connect using the connection state
      await connectionState.connectToServers({
        [serverName]: serverConfig
      });
      
    } catch (error) {
      console.error(`Failed to connect to server ${serverName}:`, error);
      throw error;
    }
  }, [serverState.serverConfigs, connectionState]);

  const handleAddServer = useCallback(async (name: string, config: MCPJamServerConfig) => {
    try {
      // Add to server state
      serverState.addServer(name, config);
      
      // If we have an active connection, add the server to it
      if (connectionState.mcpClient) {
        await connectionState.addServer(name, config);
      }
    } catch (error) {
      console.error(`Failed to add server ${name}:`, error);
      throw error;
    }
  }, [serverState, connectionState]);

  const handleRemoveServer = useCallback(async (serverName: string) => {
    try {
      // Remove from connection state first
      if (connectionState.mcpClient) {
        await connectionState.removeServer(serverName);
      }
      
      // Remove from server state
      serverState.removeServer(serverName);
    } catch (error) {
      console.error(`Failed to remove server ${serverName}:`, error);
      throw error;
    }
  }, [serverState, connectionState]);

  const handleEditClient = useCallback((serverName: string) => {
    serverState.setEditingClientName(serverName);
  }, [serverState]);

  const saveClients = useCallback(async (serverConfig: MCPJamServerConfig) => {
    try {
      if (serverState.editingClientName) {
        // Update existing server
        await handleAddServer(serverState.editingClientName, serverConfig);
      } else {
        // Add new server
        const serverName = `server-${Date.now()}`;
        await handleAddServer(serverName, serverConfig);
      }
      
      // Cancel editing
      serverState.handleCancelClientForm();
    } catch (error) {
      console.error('Failed to save client:', error);
      throw error;
    }
  }, [serverState, handleAddServer]);

  return {
    handleConnectServer,
    handleAddServer,
    handleRemoveServer,
    handleEditClient,
    saveClients,
  };
}
```

### 5. Updated App.tsx Integration

```typescript
// client/src/App.tsx (relevant sections)
import { InspectorMCPClient } from '@/lib/mcp/mastraClient';

const App = () => {
  const serverState = useServerState();
  const connectionState = useConnectionState();
  const mcpOperations = useMCPOperations();
  const configState = useConfigState();

  // Server management functions
  const {
    handleRemoveServer,
    handleEditClient,
    handleConnectServer,
    saveClients,
    handleAddServer,
  } = useServerManagement(
    serverState,
    connectionState,
    configState,
  );

  // MCP operation wrappers
  const makeRequest = useCallback(async (request: any) => {
    // For Mastra, we'll handle requests differently based on type
    if (!connectionState.mcpClient) throw new Error('No client available');
    
    if (request.method === 'tools/list') {
      await mcpOperations.listTools(connectionState.mcpClient, serverState.selectedServerName);
    } else if (request.method === 'tools/call') {
      await mcpOperations.callTool(
        connectionState.mcpClient,
        serverState.selectedServerName,
        request.params.name,
        request.params.arguments || {}
      );
    }
    // Add other methods as needed
  }, [connectionState.mcpClient, serverState.selectedServerName, mcpOperations]);

  // Updated tab rendering with simplified operations
  const renderCurrentPage = () => {
    switch (currentPage) {
      case "tools":
        return (
          <ToolsTab
            tools={mcpOperations.tools}
            listTools={() => {
              if (connectionState.mcpClient) {
                mcpOperations.listTools(connectionState.mcpClient, serverState.selectedServerName);
              }
            }}
            clearTools={() => {
              mcpOperations.setTools([]);
            }}
            callTool={async (name, params) => {
              if (connectionState.mcpClient) {
                await mcpOperations.callTool(
                  connectionState.mcpClient,
                  serverState.selectedServerName,
                  name,
                  params,
                );
              }
            }}
            selectedTool={mcpOperations.selectedTool}
            setSelectedTool={mcpOperations.setSelectedTool}
            toolResult={mcpOperations.toolResult}
            error={mcpOperations.errors.tools}
            connectionStatus={connectionState.isConnected ? "connected" : "disconnected"}
            selectedServerName={serverState.selectedServerName}
          />
        );
      
      case "resources":
        return (
          <ResourcesTab
            resources={mcpOperations.resources}
            listResources={() => {
              if (connectionState.mcpClient) {
                mcpOperations.listResources(connectionState.mcpClient, serverState.selectedServerName);
              }
            }}
            clearResources={() => {
              mcpOperations.setResources([]);
            }}
            readResource={(uri) => {
              if (connectionState.mcpClient) {
                mcpOperations.readResource(connectionState.mcpClient, serverState.selectedServerName, uri);
              }
            }}
            selectedResource={mcpOperations.selectedResource}
            setSelectedResource={mcpOperations.setSelectedResource}
            resourceContent={mcpOperations.resourceContent}
            error={mcpOperations.errors.resources}
            selectedServerName={serverState.selectedServerName}
          />
        );

      case "prompts":
        return (
          <PromptsTab
            prompts={mcpOperations.prompts}
            listPrompts={() => {
              if (connectionState.mcpClient) {
                mcpOperations.listPrompts(connectionState.mcpClient, serverState.selectedServerName);
              }
            }}
            clearPrompts={() => {
              mcpOperations.setPrompts([]);
            }}
            getPrompt={(name, args) => {
              if (connectionState.mcpClient) {
                mcpOperations.getPrompt(connectionState.mcpClient, serverState.selectedServerName, name, args);
              }
            }}
            selectedPrompt={mcpOperations.selectedPrompt}
            setSelectedPrompt={mcpOperations.setSelectedPrompt}
            promptContent={mcpOperations.promptContent}
            error={mcpOperations.errors.prompts}
            selectedServerName={serverState.selectedServerName}
          />
        );

      default:
        return null;
    }
  };

  // Rest of component...
};
```

### 6. Chat Integration with Mastra Agent

```typescript
// client/src/components/chat/ChatTab.tsx
import { Agent } from '@mastra/core/agent';
import { openai } from '@ai-sdk/openai';
import { InspectorMCPClient } from '@/lib/mcp/mastraClient';

interface ChatTabProps {
  mcpClient: InspectorMCPClient | null;
}

export default function ChatTab({ mcpClient }: ChatTabProps) {
  const [messages, setMessages] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const sendMessage = useCallback(async (content: string) => {
    if (!mcpClient) return;

    setIsLoading(true);
    try {
      // Get toolsets for dynamic tool access
      const toolsets = await mcpClient.getToolsets();

      // Create Mastra agent
      const agent = new Agent({
        name: 'MCP Inspector Assistant',
        instructions: 'You are an assistant that can use MCP tools to help users.',
        model: openai('gpt-4'),
      });

      // Generate response with toolsets
      const response = await agent.generate(content, {
        toolsets: toolsets,
      });

      // Add to messages
      setMessages(prev => [
        ...prev,
        { role: 'user', content },
        { role: 'assistant', content: response }
      ]);
    } catch (error) {
      console.error('Chat error:', error);
    } finally {
      setIsLoading(false);
    }
  }, [mcpClient]);

  // Rest of chat component...
}
```

## Migration Steps

### Phase 1: Core Replacement (Week 1)
1. **Remove existing files:**
   - `client/src/lib/utils/mcp/mcpjamAgent.ts` 
   - `client/src/lib/utils/mcp/mcpjamClient.ts`

2. **Add Mastra dependencies:**
   ```bash
   npm install @mastra/mcp @mastra/core @ai-sdk/openai
   ```

3. **Create new files:**
   - `client/src/lib/mcp/mastraClient.ts`
   - Update all hooks to use new patterns

### Phase 2: Integration (Week 2)
1. **Update App.tsx** to use new hooks and client
2. **Update all tab components** to use simplified operations  
3. **Remove proxy server dependencies** (Mastra handles connections directly)
4. **Update authentication** to work with Mastra's patterns

### Phase 3: Testing & Polish (Week 3)
1. **Comprehensive testing** of all MCP operations
2. **Performance testing** and optimization
3. **Error handling improvements**
4. **Documentation updates**

## Key Differences from Current System

### **Removed Complexity:**
- ❌ Custom MCP protocol implementation (~2000 lines)
- ❌ Complex caching system (Mastra handles this)
- ❌ Proxy server integration (direct connections)
- ❌ Custom error handling and retry logic
- ❌ Transport abstraction layer

### **Gained Benefits:**
- ✅ Industry-standard MCP implementation
- ✅ Built-in AI agent integration  
- ✅ Automatic caching and optimization
- ✅ Simplified codebase (~80% reduction)
- ✅ Future-proof with Mastra ecosystem

### **Maintained Features:**
- ✅ Multi-server support
- ✅ All MCP operations (tools, resources, prompts)
- ✅ Authentication flows
- ✅ Server configuration management
- ✅ Real-time connection status

This approach completely eliminates your custom MCP implementation while providing the same functionality through Mastra's mature, well-tested components.