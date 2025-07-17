import { ServerConfig, Tool, Resource, Prompt } from "@/app/types/mcp";

/**
 * Service for interacting with the MCP API
 */
export class McpService {
  /**
   * Get all registered servers
   */
  static async getServers(): Promise<{id: string, config: ServerConfig}[]> {
    const response = await fetch('/api/mcp-servers');
    
    if (!response.ok) {
      throw new Error(`Failed to get servers: ${response.statusText}`);
    }
    
    const data = await response.json();
    return Object.entries(data).map(([id, config]) => ({
      id,
      config: config as ServerConfig
    }));
  }
  
  /**
   * Get a specific server by ID
   */
  static async getServer(id: string): Promise<ServerConfig & {isConnected: boolean}> {
    const response = await fetch(`/api/mcp-servers/${id}`);
    
    if (!response.ok) {
      throw new Error(`Failed to get server: ${response.statusText}`);
    }
    
    return response.json();
  }
  
  /**
   * Register a new server
   */
  static async addServer(config: ServerConfig): Promise<string> {
    const response = await fetch('/api/mcp-servers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(config)
    });
    
    if (!response.ok) {
      throw new Error(`Failed to add server: ${response.statusText}`);
    }
    
    const data = await response.json();
    return data.id;
  }
  
  /**
   * Update a server configuration
   */
  static async updateServer(id: string, config: ServerConfig): Promise<void> {
    const response = await fetch(`/api/mcp-servers/${id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(config)
    });
    
    if (!response.ok) {
      throw new Error(`Failed to update server: ${response.statusText}`);
    }
  }
  
  /**
   * Delete a server
   */
  static async deleteServer(id: string): Promise<void> {
    const response = await fetch(`/api/mcp-servers/${id}`, {
      method: 'DELETE'
    });
    
    if (!response.ok) {
      throw new Error(`Failed to delete server: ${response.statusText}`);
    }
  }
  
  /**
   * Connect to an MCP server
   */
  static async connectToServer(id: string): Promise<void> {
    const response = await fetch(`/api/mcp-servers/${id}/connect`, {
      method: 'POST'
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Failed to connect: ${errorData.error || response.statusText}`);
    }
  }
  
  /**
   * Disconnect from an MCP server
   */
  static async disconnectFromServer(id: string): Promise<void> {
    const response = await fetch(`/api/mcp-servers/${id}/connect`, {
      method: 'DELETE'
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Failed to disconnect: ${errorData.error || response.statusText}`);
    }
  }
  
  /**
   * Get all tools from a server
   */
  static async getTools(serverId: string): Promise<Tool[]> {
    const response = await fetch(`/api/mcp-servers/${serverId}/tools`);
    
    if (!response.ok) {
      throw new Error(`Failed to get tools: ${response.statusText}`);
    }
    
    return response.json();
  }
  
  /**
   * Execute a tool on a server
   */
  static async executeTool(serverId: string, toolName: string, parameters: any): Promise<any> {
    const response = await fetch(`/api/mcp-servers/${serverId}/tools/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        toolName,
        parameters
      })
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Failed to execute tool: ${errorData.error || response.statusText}`);
    }
    
    return response.json();
  }
  
  /**
   * Get all resources from a server
   */
  static async getResources(serverId: string): Promise<Resource[]> {
    const response = await fetch(`/api/mcp-servers/${serverId}/resources`);
    
    if (!response.ok) {
      throw new Error(`Failed to get resources: ${response.statusText}`);
    }
    
    return response.json();
  }
  
  /**
   * Read a resource from a server
   */
  static async readResource(serverId: string, uri: string): Promise<any> {
    const response = await fetch(`/api/mcp-servers/${serverId}/resources/read`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ uri })
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Failed to read resource: ${errorData.error || response.statusText}`);
    }
    
    return response.json();
  }
  
  /**
   * Get all prompts from a server
   */
  static async getPrompts(serverId: string): Promise<Prompt[]> {
    const response = await fetch(`/api/mcp-servers/${serverId}/prompts`);
    
    if (!response.ok) {
      throw new Error(`Failed to get prompts: ${response.statusText}`);
    }
    
    return response.json();
  }
  
  /**
   * Get a prompt from a server
   */
  static async getPrompt(serverId: string, name: string, args?: any): Promise<any> {
    const response = await fetch(`/api/mcp-servers/${serverId}/prompts/get`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name, args })
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Failed to get prompt: ${errorData.error || response.statusText}`);
    }
    
    return response.json();
  }
}