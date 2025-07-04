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

export class HTTPBrowserDatabase {
  private baseUrl: string;
  private initialized = false;

  constructor(config: DatabaseConfig = {}) {
    // Use environment variable or default to server port 3333
    this.baseUrl = config.baseUrl || 
                   import.meta.env.VITE_DATABASE_BASE_URL || 
                   `${window.location.protocol}//${window.location.hostname}:3333`;
  }

  /**
   * Initialize the database connection
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    
    try {
      // Test connection to the database API
      const response = await fetch(`${this.baseUrl}/api/database/user-preferences`);
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
      const response = await fetch(`${this.baseUrl}/api/database/server-configs`);
      if (!response.ok) {
        throw new Error(`Failed to fetch server configs: ${response.status}`);
      }
      
      const configs = await response.json();
      
      // Convert array to object keyed by name
      const configsByName: Record<string, MCPJamServerConfig> = {};
      for (const config of configs) {
        configsByName[config.name] = config;
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
      // First, try to find existing config by name
      const existingConfigs = await this.getAllServerConfigs();
      const existingConfig = existingConfigs[name];
      
      const configData = {
        name,
        transportType: config.transportType || 'stdio',
        command: config.command,
        args: config.args,
        env: config.env,
        url: config.url?.toString(),
        timeout: config.timeout || 30000,
        enableServerLogs: config.enableServerLogs || false,
      };
      
      if (existingConfig) {
        // Update existing config
        const response = await fetch(`${this.baseUrl}/api/database/server-configs/${existingConfig.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(configData),
        });
        
        if (!response.ok) {
          throw new Error(`Failed to update server config: ${response.status}`);
        }
      } else {
        // Create new config
        const response = await fetch(`${this.baseUrl}/api/database/server-configs`, {
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
      const existingConfigs = await this.getAllServerConfigs();
      const existingConfig = existingConfigs[name];
      
      if (!existingConfig) {
        console.warn(`Server config ${name} not found`);
        return;
      }
      
      const response = await fetch(`${this.baseUrl}/api/database/server-configs/${existingConfig.id}`, {
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
      const response = await fetch(`${this.baseUrl}/api/database/user-preferences`);
      
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
      const response = await fetch(`${this.baseUrl}/api/database/user-preferences`, {
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
      const response = await fetch(`${this.baseUrl}/api/database/request-history`);
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
        toolName: request.method || 'unknown',
        toolDefinition: { method: request.method, params: request.params },
        parameters: request.params || {},
        clientId: 'browser-client',
        isFavorite: false,
      };
      
      const response = await fetch(`${this.baseUrl}/api/database/request-history`, {
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
      const response = await fetch(`${this.baseUrl}/api/database/request-history/${id}`, {
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
      const response = await fetch(`${this.baseUrl}/api/database/request-history/${id}`, {
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