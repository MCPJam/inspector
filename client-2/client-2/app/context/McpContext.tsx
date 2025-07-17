"use client";

import React, { createContext, useState, useContext, useEffect, ReactNode } from 'react';
import { ServerConfig, Tool, Resource, Prompt } from '@/app/types/mcp';
import { McpService } from '@/app/services/mcpService';

// Interface for the context state
interface McpContextState {
  servers: Record<string, ServerConfig & { id: string, isConnected: boolean }>;
  activeServerId: string | null;
  tools: Record<string, Tool[]>;
  resources: Record<string, Resource[]>;
  prompts: Record<string, Prompt[]>;
  isLoading: boolean;
  error: string | null;
}

// Interface for context value
interface McpContextValue extends McpContextState {
  loadServers: () => Promise<void>;
  addServer: (config: ServerConfig) => Promise<string>;
  updateServer: (id: string, config: ServerConfig) => Promise<void>;
  deleteServer: (id: string) => Promise<void>;
  connectToServer: (id: string) => Promise<void>;
  disconnectFromServer: (id: string) => Promise<void>;
  setActiveServer: (id: string | null) => void;
  loadTools: (serverId: string) => Promise<void>;
  executeTool: (serverId: string, toolName: string, parameters: any) => Promise<any>;
  loadResources: (serverId: string) => Promise<void>;
  readResource: (serverId: string, uri: string) => Promise<any>;
  loadPrompts: (serverId: string) => Promise<void>;
  getPrompt: (serverId: string, name: string, args?: any) => Promise<any>;
}

// Create the context with default values
const McpContext = createContext<McpContextValue>({
  servers: {},
  activeServerId: null,
  tools: {},
  resources: {},
  prompts: {},
  isLoading: false,
  error: null,
  loadServers: async () => {},
  addServer: async () => "",
  updateServer: async () => {},
  deleteServer: async () => {},
  connectToServer: async () => {},
  disconnectFromServer: async () => {},
  setActiveServer: () => {},
  loadTools: async () => {},
  executeTool: async () => ({}),
  loadResources: async () => {},
  readResource: async () => ({}),
  loadPrompts: async () => {},
  getPrompt: async () => ({})
});

// Provider component
export const McpProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [state, setState] = useState<McpContextState>({
    servers: {},
    activeServerId: null,
    tools: {},
    resources: {},
    prompts: {},
    isLoading: false,
    error: null
  });
  
  // Load servers on initial mount
  useEffect(() => {
    loadServers();
  }, []);

  // Load servers from the API
  const loadServers = async () => {
    setState(prev => ({ ...prev, isLoading: true, error: null }));
    
    try {
      const serversList = await McpService.getServers();
      const servers: Record<string, ServerConfig & { id: string, isConnected: boolean }> = {};
      
      for (const { id, config } of serversList) {
        const serverDetails = await McpService.getServer(id);
        servers[id] = { ...config, id, isConnected: serverDetails.isConnected };
      }
      
      setState(prev => ({
        ...prev,
        servers,
        isLoading: false
      }));
    } catch (error) {
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to load servers'
      }));
    }
  };

  // Add a new server
  const addServer = async (config: ServerConfig): Promise<string> => {
    setState(prev => ({ ...prev, isLoading: true, error: null }));
    
    try {
      const id = await McpService.addServer(config);
      
      setState(prev => ({
        ...prev,
        servers: {
          ...prev.servers,
          [id]: { ...config, id, isConnected: false }
        },
        isLoading: false
      }));
      
      return id;
    } catch (error) {
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to add server'
      }));
      throw error;
    }
  };

  // Update a server
  const updateServer = async (id: string, config: ServerConfig): Promise<void> => {
    setState(prev => ({ ...prev, isLoading: true, error: null }));
    
    try {
      await McpService.updateServer(id, config);
      
      setState(prev => ({
        ...prev,
        servers: {
          ...prev.servers,
          [id]: { ...config, id, isConnected: prev.servers[id]?.isConnected || false }
        },
        isLoading: false
      }));
    } catch (error) {
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to update server'
      }));
      throw error;
    }
  };

  // Delete a server
  const deleteServer = async (id: string): Promise<void> => {
    setState(prev => ({ ...prev, isLoading: true, error: null }));
    
    try {
      await McpService.deleteServer(id);
      
      const { [id]: _, ...remainingServers } = state.servers;
      
      setState(prev => ({
        ...prev,
        servers: remainingServers,
        activeServerId: prev.activeServerId === id ? null : prev.activeServerId,
        isLoading: false
      }));
    } catch (error) {
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to delete server'
      }));
      throw error;
    }
  };

  // Connect to a server
  const connectToServer = async (id: string): Promise<void> => {
    setState(prev => ({ ...prev, isLoading: true, error: null }));
    
    try {
      await McpService.connectToServer(id);
      
      setState(prev => ({
        ...prev,
        servers: {
          ...prev.servers,
          [id]: { ...prev.servers[id], isConnected: true }
        },
        isLoading: false
      }));
    } catch (error) {
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to connect to server'
      }));
      throw error;
    }
  };

  // Disconnect from a server
  const disconnectFromServer = async (id: string): Promise<void> => {
    setState(prev => ({ ...prev, isLoading: true, error: null }));
    
    try {
      await McpService.disconnectFromServer(id);
      
      setState(prev => ({
        ...prev,
        servers: {
          ...prev.servers,
          [id]: { ...prev.servers[id], isConnected: false }
        },
        isLoading: false
      }));
    } catch (error) {
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to disconnect from server'
      }));
      throw error;
    }
  };

  // Set active server
  const setActiveServer = (id: string | null) => {
    setState(prev => ({
      ...prev,
      activeServerId: id
    }));
  };

  // Load tools from a server
  const loadTools = async (serverId: string): Promise<void> => {
    setState(prev => ({ ...prev, isLoading: true, error: null }));
    
    try {
      const tools = await McpService.getTools(serverId);
      
      setState(prev => ({
        ...prev,
        tools: {
          ...prev.tools,
          [serverId]: tools
        },
        isLoading: false
      }));
    } catch (error) {
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to load tools'
      }));
      throw error;
    }
  };

  // Execute a tool
  const executeTool = async (serverId: string, toolName: string, parameters: any): Promise<any> => {
    setState(prev => ({ ...prev, isLoading: true, error: null }));
    
    try {
      const result = await McpService.executeTool(serverId, toolName, parameters);
      setState(prev => ({ ...prev, isLoading: false }));
      return result;
    } catch (error) {
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to execute tool'
      }));
      throw error;
    }
  };

  // Load resources from a server
  const loadResources = async (serverId: string): Promise<void> => {
    setState(prev => ({ ...prev, isLoading: true, error: null }));
    
    try {
      const resources = await McpService.getResources(serverId);
      
      setState(prev => ({
        ...prev,
        resources: {
          ...prev.resources,
          [serverId]: resources
        },
        isLoading: false
      }));
    } catch (error) {
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to load resources'
      }));
      throw error;
    }
  };

  // Read a resource
  const readResource = async (serverId: string, uri: string): Promise<any> => {
    setState(prev => ({ ...prev, isLoading: true, error: null }));
    
    try {
      const result = await McpService.readResource(serverId, uri);
      setState(prev => ({ ...prev, isLoading: false }));
      return result;
    } catch (error) {
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to read resource'
      }));
      throw error;
    }
  };

  // Load prompts from a server
  const loadPrompts = async (serverId: string): Promise<void> => {
    setState(prev => ({ ...prev, isLoading: true, error: null }));
    
    try {
      const prompts = await McpService.getPrompts(serverId);
      
      setState(prev => ({
        ...prev,
        prompts: {
          ...prev.prompts,
          [serverId]: prompts
        },
        isLoading: false
      }));
    } catch (error) {
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to load prompts'
      }));
      throw error;
    }
  };

  // Get a prompt
  const getPrompt = async (serverId: string, name: string, args?: any): Promise<any> => {
    setState(prev => ({ ...prev, isLoading: true, error: null }));
    
    try {
      const result = await McpService.getPrompt(serverId, name, args);
      setState(prev => ({ ...prev, isLoading: false }));
      return result;
    } catch (error) {
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to get prompt'
      }));
      throw error;
    }
  };

  return (
    <McpContext.Provider 
      value={{
        ...state,
        loadServers,
        addServer,
        updateServer,
        deleteServer,
        connectToServer,
        disconnectFromServer,
        setActiveServer,
        loadTools,
        executeTool,
        loadResources,
        readResource,
        loadPrompts,
        getPrompt
      }}
    >
      {children}
    </McpContext.Provider>
  );
};

// Custom hook for using the MCP context
export const useMcp = () => useContext(McpContext);

export default McpContext;