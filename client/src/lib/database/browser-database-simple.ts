/**
 * Simple localStorage-based database implementation
 * This provides the same API as the libSQL version but uses localStorage as the backend
 * This is a temporary solution until we get libSQL working properly in the browser
 */

export interface DatabaseConfig {
  url?: string;
  authToken?: string;
  localPath?: string;
  syncUrl?: string;
  syncToken?: string;
}

export class SimpleBrowserDatabase {
  private initialized = false;

  constructor(_config?: DatabaseConfig) {
    // For the simple version, we don't need the config
    // but we keep it for API compatibility
  }

  /**
   * Initialize the database (no-op for localStorage version)
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
  }

  /**
   * Close the database connection (no-op for localStorage version)
   */
  async close(): Promise<void> {
    // Nothing to close for localStorage
  }

  /**
   * Generate a UUID for browser environment
   */
  private generateId(): string {
    return crypto.randomUUID();
  }

  /**
   * Get the current timestamp
   */
  private getCurrentTimestamp(): string {
    return new Date().toISOString();
  }

  // Server Config Methods
  async getAllServerConfigs(): Promise<Record<string, any>> {
    await this.initialize();
    
    try {
      const stored = localStorage.getItem('mcpjam_db_server_configs');
      if (stored) {
        return JSON.parse(stored);
      }
    } catch (error) {
      console.warn('Failed to load server configs:', error);
    }
    
    return {};
  }

  async updateServerConfig(name: string, config: any): Promise<void> {
    await this.initialize();
    
    try {
      const configs = await this.getAllServerConfigs();
      configs[name] = {
        ...config,
        url: config.url ? config.url.toString() : undefined,
        updatedAt: this.getCurrentTimestamp(),
      };
      
      localStorage.setItem('mcpjam_db_server_configs', JSON.stringify(configs));
    } catch (error) {
      console.error('Failed to update server config:', error);
      throw error;
    }
  }

  async deleteServerConfig(name: string): Promise<void> {
    await this.initialize();
    
    try {
      const configs = await this.getAllServerConfigs();
      delete configs[name];
      
      if (Object.keys(configs).length > 0) {
        localStorage.setItem('mcpjam_db_server_configs', JSON.stringify(configs));
      } else {
        localStorage.removeItem('mcpjam_db_server_configs');
      }
    } catch (error) {
      console.error('Failed to delete server config:', error);
      throw error;
    }
  }

  async getSelectedServer(): Promise<string> {
    await this.initialize();
    
    try {
      return localStorage.getItem('mcpjam_db_selected_server') || '';
    } catch (error) {
      console.warn('Failed to get selected server:', error);
      return '';
    }
  }

  async setSelectedServer(serverName: string): Promise<void> {
    await this.initialize();
    
    try {
      if (serverName) {
        localStorage.setItem('mcpjam_db_selected_server', serverName);
      } else {
        localStorage.removeItem('mcpjam_db_selected_server');
      }
    } catch (error) {
      console.error('Failed to set selected server:', error);
      throw error;
    }
  }

  // User Preferences Methods
  async getUserPreferences(): Promise<any> {
    await this.initialize();
    
    try {
      const stored = localStorage.getItem('mcpjam_db_user_preferences');
      if (stored) {
        return JSON.parse(stored);
      }
    } catch (error) {
      console.warn('Failed to load user preferences:', error);
    }
    
    return {
      theme: 'system',
      autoOpenEnabled: true,
      hasSeenStarModal: false,
    };
  }

  async updateUserPreferences(preferences: any): Promise<void> {
    await this.initialize();
    
    try {
      const current = await this.getUserPreferences();
      const updated = {
        ...current,
        ...preferences,
        updatedAt: this.getCurrentTimestamp(),
      };
      
      localStorage.setItem('mcpjam_db_user_preferences', JSON.stringify(updated));
    } catch (error) {
      console.error('Failed to update user preferences:', error);
      throw error;
    }
  }

  // Request History Methods
  async getAllRequestHistory(): Promise<any[]> {
    await this.initialize();
    
    try {
      const stored = localStorage.getItem('mcpjam_db_request_history');
      if (stored) {
        const data = JSON.parse(stored);
        return data.requests || [];
      }
    } catch (error) {
      console.warn('Failed to load request history:', error);
    }
    
    return [];
  }

  async addRequestHistory(request: any): Promise<void> {
    await this.initialize();
    
    try {
      const requests = await this.getAllRequestHistory();
      const newRequest = {
        ...request,
        id: request.id || this.generateId(),
        createdAt: request.createdAt || this.getCurrentTimestamp(),
        updatedAt: this.getCurrentTimestamp(),
      };
      
      requests.push(newRequest);
      
      const collection = {
        requests,
        version: "1.0.0",
        exportedAt: this.getCurrentTimestamp(),
      };
      
      localStorage.setItem('mcpjam_db_request_history', JSON.stringify(collection));
    } catch (error) {
      console.error('Failed to add request history:', error);
      throw error;
    }
  }

  async updateRequestHistory(id: string, updates: any): Promise<void> {
    await this.initialize();
    
    try {
      const requests = await this.getAllRequestHistory();
      const index = requests.findIndex(r => r.id === id);
      
      if (index !== -1) {
        requests[index] = {
          ...requests[index],
          ...updates,
          updatedAt: this.getCurrentTimestamp(),
        };
        
        const collection = {
          requests,
          version: "1.0.0",
          exportedAt: this.getCurrentTimestamp(),
        };
        
        localStorage.setItem('mcpjam_db_request_history', JSON.stringify(collection));
      }
    } catch (error) {
      console.error('Failed to update request history:', error);
      throw error;
    }
  }

  async deleteRequestHistory(id: string): Promise<void> {
    await this.initialize();
    
    try {
      const requests = await this.getAllRequestHistory();
      const filtered = requests.filter(r => r.id !== id);
      
      if (filtered.length > 0) {
        const collection = {
          requests: filtered,
          version: "1.0.0",
          exportedAt: this.getCurrentTimestamp(),
        };
        
        localStorage.setItem('mcpjam_db_request_history', JSON.stringify(collection));
      } else {
        localStorage.removeItem('mcpjam_db_request_history');
      }
    } catch (error) {
      console.error('Failed to delete request history:', error);
      throw error;
    }
  }

  async clearAllRequestHistory(): Promise<void> {
    await this.initialize();
    
    try {
      localStorage.removeItem('mcpjam_db_request_history');
    } catch (error) {
      console.error('Failed to clear request history:', error);
      throw error;
    }
  }
}

// Create singleton instance
export const browserDatabase = new SimpleBrowserDatabase(); 