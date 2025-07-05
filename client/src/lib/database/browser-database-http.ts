/**
 * HTTP-based database client for browser environments
 * Communicates with the server's database API endpoints instead of using LibSQL directly
 * This avoids the file:// URL issue in browsers while sharing the same database with CLI
 */

export interface UserPreferences {
  theme: 'light' | 'dark' | 'system';
  autoOpenEnabled: boolean;
  hasSeenStarModal: boolean;
  paneHeights?: Record<string, number>;
  [key: string]: unknown;
}

export interface DatabaseConfig {
  baseUrl?: string; // Server URL for API calls
}

import type { MCPJamServerConfig } from '../types/serverTypes';
import type { McpJamRequest } from '../types/requestTypes';
import { DEFAULT_MCP_PROXY_LISTEN_PORT } from '../types/constants';

// Server config with ID (as returned by database)
interface ServerConfigWithId {
  id: string;
  name: string;
  transportType: 'stdio' | 'sse' | 'streamable-http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  requestInit?: Record<string, unknown>;
  eventSourceInit?: Record<string, unknown>;
  reconnectionOptions?: Record<string, unknown>;
  sessionId?: string;
  timeout?: number;
  capabilities?: Record<string, unknown>;
  enableServerLogs?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export class HTTPBrowserDatabase {
  private baseUrl: string | null = null;
  private initialized = false;
  private configuredBaseUrl: string | null = null;

  constructor(config: DatabaseConfig = {}) {
    // Store the configured base URL if provided
    this.configuredBaseUrl = config.baseUrl || import.meta.env.VITE_DATABASE_BASE_URL || null;
  }

  /**
   * Discover the actual port used by the server
   */
  private async discoverActualPort(): Promise<string> {
    // Try multiple ports starting from the default port
    const startPort = parseInt(DEFAULT_MCP_PROXY_LISTEN_PORT);
    const maxAttempts = 5; // Try 5 consecutive ports

    console.log(`🔍 Starting port discovery from port ${startPort}`);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const tryPort = startPort + attempt;

      try {
        const testUrl = `${window.location.protocol}//${window.location.hostname}:${tryPort}/port`;
        console.log(`🔍 Trying port discovery at: ${testUrl}`);
        
        const response = await fetch(testUrl);

        if (response.ok) {
          const data = await response.json();
          const actualPort = data.port.toString();
          console.log(`✅ Discovered actual port: ${actualPort}`);
          return actualPort;
        } else {
          console.debug(`Port discovery: port ${tryPort} responded with status ${response.status}`);
        }
      } catch (error) {
        // Continue to next port
        console.debug(
          `Port discovery: failed to connect to port ${tryPort}:`,
          error,
        );
      }
    }

    console.warn(
      "Failed to discover actual port, using default:",
      DEFAULT_MCP_PROXY_LISTEN_PORT,
    );
    return DEFAULT_MCP_PROXY_LISTEN_PORT;
  }

  /**
   * Get the base URL for API calls
   */
  private async getBaseUrl(): Promise<string> {
    if (this.baseUrl) {
      console.log(`🔄 Using cached base URL: ${this.baseUrl}`);
      return this.baseUrl;
    }

    // If a configured base URL is provided, use it
    if (this.configuredBaseUrl) {
      console.log(`🔄 Using configured base URL: ${this.configuredBaseUrl}`);
      this.baseUrl = this.configuredBaseUrl;
      return this.baseUrl;
    }

    // Otherwise, discover the actual port
    console.log(`🔄 No cached or configured URL, starting port discovery...`);
    const actualPort = await this.discoverActualPort();
    this.baseUrl = `${window.location.protocol}//${window.location.hostname}:${actualPort}`;
    console.log(`🔄 Final base URL: ${this.baseUrl}`);
    return this.baseUrl;
  }

  /**
   * Initialize the database connection
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    
    try {
      // Get the base URL (with port discovery)
      const baseUrl = await this.getBaseUrl();
      
      // Test connection to the database API
      const response = await fetch(`${baseUrl}/api/database/user-preferences`);
      if (!response.ok && response.status !== 404) {
        throw new Error(`Database API not available: ${response.status}`);
      }
      
      this.initialized = true;
      console.log('✅ HTTP database client initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize HTTP database client:', error);
      throw error;
    }
  }

  /**
   * Close the database connection (no-op for HTTP client)
   */
  async close(): Promise<void> {
    // No action needed for HTTP client
  }

  // Server Config Methods
  async getAllServerConfigs(): Promise<Record<string, MCPJamServerConfig>> {
    await this.initialize();
    
    try {
      const baseUrl = await this.getBaseUrl();
      const response = await fetch(`${baseUrl}/api/database/server-configs`);
      if (!response.ok) {
        throw new Error(`Failed to fetch server configs: ${response.status}`);
      }
      
      const configs = await response.json();
      
      // Convert array to object keyed by name, removing database-specific fields
      const configsByName: Record<string, MCPJamServerConfig> = {};
      for (const config of configs) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { id, createdAt, updatedAt, ...mcpConfig } = config;
        configsByName[config.name] = mcpConfig;
      }
      
      return configsByName;
    } catch (error) {
      console.error('Failed to load server configs:', error);
      return {};
    }
  }

  async updateServerConfig(name: string, config: MCPJamServerConfig): Promise<void> {
    await this.initialize();
    
    try {
      // First, get all server configs to find existing one by name
      const baseUrl = await this.getBaseUrl();
      const existingConfigsResponse = await fetch(`${baseUrl}/api/database/server-configs`);
      if (!existingConfigsResponse.ok) {
        throw new Error(`Failed to fetch server configs: ${existingConfigsResponse.status}`);
      }
      
      const existingConfigs: ServerConfigWithId[] = await existingConfigsResponse.json();
      const existingConfig = existingConfigs.find(c => c.name === name);
      
      const configData = {
        name,
        transportType: config.transportType || 'stdio',
        command: 'command' in config ? config.command : undefined,
        args: 'args' in config ? config.args : undefined,
        env: 'env' in config ? config.env : undefined,
        url: 'url' in config ? config.url?.toString() : undefined,
        timeout: config.timeout || 30000,
        enableServerLogs: config.enableServerLogs || false,
      };
      
      if (existingConfig) {
        // Update existing config
        const response = await fetch(`${baseUrl}/api/database/server-configs/${existingConfig.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(configData),
        });
        
        if (!response.ok) {
          throw new Error(`Failed to update server config: ${response.status}`);
        }
      } else {
        // Create new config
        const response = await fetch(`${baseUrl}/api/database/server-configs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(configData),
        });
        
        if (!response.ok) {
          throw new Error(`Failed to create server config: ${response.status}`);
        }
      }
    } catch (error) {
      console.error('Failed to update server config:', error);
      throw error;
    }
  }

  async deleteServerConfig(name: string): Promise<void> {
    await this.initialize();
    
    try {
      // Find config by name first
      const baseUrl = await this.getBaseUrl();
      const existingConfigsResponse = await fetch(`${baseUrl}/api/database/server-configs`);
      if (!existingConfigsResponse.ok) {
        throw new Error(`Failed to fetch server configs: ${existingConfigsResponse.status}`);
      }
      
      const existingConfigs: ServerConfigWithId[] = await existingConfigsResponse.json();
      const existingConfig = existingConfigs.find(c => c.name === name);
      
      if (!existingConfig) {
        console.warn(`Server config ${name} not found`);
        return;
      }
      
      const response = await fetch(`${baseUrl}/api/database/server-configs/${existingConfig.id}`, {
        method: 'DELETE',
      });
      
      if (!response.ok) {
        throw new Error(`Failed to delete server config: ${response.status}`);
      }
    } catch (error) {
      console.error('Failed to delete server config:', error);
      throw error;
    }
  }

  async getSelectedServer(): Promise<string> {
    // For now, return empty string - we can implement selected server storage later
    return '';
  }

  async setSelectedServer(serverName: string): Promise<void> {
    // For now, no-op - we can implement selected server storage later
    console.log('Selected server:', serverName);
  }

  // User Preferences Methods
  async getUserPreferences(): Promise<UserPreferences> {
    await this.initialize();
    
    try {
      const baseUrl = await this.getBaseUrl();
      const response = await fetch(`${baseUrl}/api/database/user-preferences`);
      
      if (response.status === 404) {
        // No preferences exist yet, return defaults
        return {
          theme: 'system',
          autoOpenEnabled: true,
          hasSeenStarModal: false,
        };
      }
      
      if (!response.ok) {
        throw new Error(`Failed to fetch user preferences: ${response.status}`);
      }
      
      return await response.json();
    } catch (error) {
      console.warn('Failed to load user preferences:', error);
      return {
        theme: 'system',
        autoOpenEnabled: true,
        hasSeenStarModal: false,
      };
    }
  }

  async updateUserPreferences(preferences: Partial<UserPreferences>): Promise<void> {
    await this.initialize();
    
    try {
      const baseUrl = await this.getBaseUrl();
      const response = await fetch(`${baseUrl}/api/database/user-preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(preferences),
      });
      
      if (!response.ok) {
        throw new Error(`Failed to update user preferences: ${response.status}`);
      }
    } catch (error) {
      console.error('Failed to update user preferences:', error);
      throw error;
    }
  }

  // Request History Methods
  async getAllRequestHistory(): Promise<McpJamRequest[]> {
    await this.initialize();
    
    try {
      const baseUrl = await this.getBaseUrl();
      const response = await fetch(`${baseUrl}/api/database/request-history`);
      if (!response.ok) {
        throw new Error(`Failed to fetch request history: ${response.status}`);
      }
      
      const result = await response.json();
      return result.items || [];
    } catch (error) {
      console.warn('Failed to load request history:', error);
      return [];
    }
  }

  async addRequestHistory(request: McpJamRequest): Promise<void> {
    await this.initialize();
    
    try {
      const requestData = {
        name: request.name || `Request ${Date.now()}`,
        description: request.description,
        toolName: request.toolName || 'unknown',
        toolDefinition: request.tool || { name: request.toolName, inputSchema: {} },
        parameters: request.parameters || {},
        clientId: request.clientId || 'browser-client',
        isFavorite: request.isFavorite || false,
      };
      
      const baseUrl = await this.getBaseUrl();
      const response = await fetch(`${baseUrl}/api/database/request-history`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestData),
      });
      
      if (!response.ok) {
        throw new Error(`Failed to add request history: ${response.status}`);
      }
    } catch (error) {
      console.error('Failed to add request history:', error);
      throw error;
    }
  }

  async updateRequestHistory(id: string, updates: Partial<McpJamRequest>): Promise<void> {
    await this.initialize();
    
    try {
      const baseUrl = await this.getBaseUrl();
      const response = await fetch(`${baseUrl}/api/database/request-history/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      
      if (!response.ok) {
        throw new Error(`Failed to update request history: ${response.status}`);
      }
    } catch (error) {
      console.error('Failed to update request history:', error);
      throw error;
    }
  }

  async deleteRequestHistory(id: string): Promise<void> {
    await this.initialize();
    
    try {
      const baseUrl = await this.getBaseUrl();
      const response = await fetch(`${baseUrl}/api/database/request-history/${id}`, {
        method: 'DELETE',
      });
      
      if (!response.ok) {
        throw new Error(`Failed to delete request history: ${response.status}`);
      }
    } catch (error) {
      console.error('Failed to delete request history:', error);
      throw error;
    }
  }

  async clearAllRequestHistory(): Promise<void> {
    // For now, we'd need to implement a bulk delete endpoint
    console.warn('Clear all request history not implemented yet');
  }
}

// Create singleton instance
export const httpBrowserDatabase = new HTTPBrowserDatabase();

// Debug: log the initial configuration
console.log('🔧 HTTPBrowserDatabase singleton created with config:', {
  configuredBaseUrl: (httpBrowserDatabase as unknown as { configuredBaseUrl: string | null }).configuredBaseUrl,
  env: import.meta.env.VITE_DATABASE_BASE_URL
});