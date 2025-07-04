/**
 * Real libSQL implementation for browser environments
 * Uses @libsql/client with WebAssembly for local SQLite or HTTP for remote Turso
 */

import { createClient, type Client } from '@libsql/client';
import type { MCPJamServerConfig } from '../types/serverTypes';
import type { McpJamRequest } from '../types/requestTypes';

export interface UserPreferences {
  theme: 'light' | 'dark' | 'system';
  autoOpenEnabled: boolean;
  hasSeenStarModal: boolean;
  paneHeights?: Record<string, number>;
  [key: string]: unknown;
}

export interface DatabaseConfig {
  url?: string;
  authToken?: string;
  localPath?: string;
  syncUrl?: string;
  syncToken?: string;
}

export class LibSQLBrowserDatabase {
  private client: Client | null = null;
  private initialized = false;

  constructor(private config: DatabaseConfig = {}) {}

  /**
   * Initialize the database connection and create tables
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      console.log('🔍 LibSQL client import check:', { createClient: typeof createClient });
      console.log('🔍 Original database config:', { originalUrl: this.config.url, fullConfig: this.config });
      
      // Try multiple approaches to create an in-memory database client
      console.log('🔍 Attempting to create LibSQL client with :memory:');
      
      // Approach 1: Try with just the URL string
      try {
        console.log('🔍 Trying createClient(":memory:")');
        this.client = createClient(':memory:');
        console.log('✅ Successfully created client with string URL');
      } catch (error1) {
        console.log('❌ String URL failed:', error1);
        
        // Approach 2: Try with minimal config object
        try {
          console.log('🔍 Trying createClient({ url: ":memory:" })');
          this.client = createClient({ url: ':memory:' });
          console.log('✅ Successfully created client with config object');
        } catch (error2) {
          console.log('❌ Config object failed:', error2);
          
          // Approach 3: Try completely different approach - throw error with detailed info
          throw new Error(`Failed to create LibSQL client. Both approaches failed:
            1. String URL: ${error1.message}
            2. Config object: ${error2.message}
            LibSQL version: @libsql/client ^0.5.6
            Environment: Browser
            Original config: ${JSON.stringify(this.config)}`);
        }
      }

      // Create tables
      await this.createTables();
      
      this.initialized = true;
      console.log('✅ LibSQL database initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize LibSQL database:', error);
      throw error;
    }
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.initialized = false;
    }
  }

  /**
   * Create database tables
   */
  private async createTables(): Promise<void> {
    if (!this.client) throw new Error('Database not initialized');

    const schema = `
      -- Server configurations
      CREATE TABLE IF NOT EXISTS server_configs (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        config_data TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- Selected server
      CREATE TABLE IF NOT EXISTS selected_server (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        server_name TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- User preferences
      CREATE TABLE IF NOT EXISTS user_preferences (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        preferences_data TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- Request history
      CREATE TABLE IF NOT EXISTS request_history (
        id TEXT PRIMARY KEY,
        request_data TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- Indexes for performance
      CREATE INDEX IF NOT EXISTS idx_server_configs_name ON server_configs(name);
      CREATE INDEX IF NOT EXISTS idx_request_history_created_at ON request_history(created_at);

      -- Update triggers
      CREATE TRIGGER IF NOT EXISTS update_server_configs_timestamp 
        AFTER UPDATE ON server_configs
        BEGIN
          UPDATE server_configs SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
        END;

      CREATE TRIGGER IF NOT EXISTS update_selected_server_timestamp 
        AFTER UPDATE ON selected_server
        BEGIN
          UPDATE selected_server SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
        END;

      CREATE TRIGGER IF NOT EXISTS update_user_preferences_timestamp 
        AFTER UPDATE ON user_preferences
        BEGIN
          UPDATE user_preferences SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
        END;

      CREATE TRIGGER IF NOT EXISTS update_request_history_timestamp 
        AFTER UPDATE ON request_history
        BEGIN
          UPDATE request_history SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
        END;
    `;

    await this.client.executeMultiple(schema);
  }

  /**
   * Generate a UUID for browser environment
   */
  private generateId(): string {
    return crypto.randomUUID();
  }

  // Server Config Methods
  async getAllServerConfigs(): Promise<Record<string, MCPJamServerConfig>> {
    await this.initialize();
    if (!this.client) throw new Error('Database not initialized');

    try {
      const result = await this.client.execute({
        sql: 'SELECT name, config_data FROM server_configs ORDER BY name',
        args: []
      });

      const configs: Record<string, MCPJamServerConfig> = {};
      
      for (const row of result.rows) {
        const name = row.name as string;
        const configData = row.config_data as string;
        
        const parsedConfig = JSON.parse(configData) as Record<string, unknown>;
        
        // Deserialize URL if it exists (only for HTTP servers)
        if (parsedConfig.url && typeof parsedConfig.url === 'string') {
          parsedConfig.url = new URL(parsedConfig.url);
        }
        
        const config = parsedConfig as MCPJamServerConfig;
        
        configs[name] = config;
      }

      return configs;
    } catch (error) {
      console.error('Failed to load server configs:', error);
      return {};
    }
  }

  async updateServerConfig(name: string, config: MCPJamServerConfig): Promise<void> {
    await this.initialize();
    if (!this.client) throw new Error('Database not initialized');

    try {
      // Serialize URL for storage
      const configToStore = { ...config } as Record<string, unknown>;
      
      // Handle URL serialization for HTTP servers
      if ('url' in config && config.url instanceof URL) {
        configToStore.url = config.url.toString();
      }

      await this.client.execute({
        sql: `
          INSERT INTO server_configs (id, name, config_data)
          VALUES (?, ?, ?)
          ON CONFLICT(name) DO UPDATE SET
            config_data = excluded.config_data,
            updated_at = CURRENT_TIMESTAMP
        `,
        args: [this.generateId(), name, JSON.stringify(configToStore)]
      });
    } catch (error) {
      console.error('Failed to update server config:', error);
      throw error;
    }
  }

  async deleteServerConfig(name: string): Promise<void> {
    await this.initialize();
    if (!this.client) throw new Error('Database not initialized');

    try {
      await this.client.execute({
        sql: 'DELETE FROM server_configs WHERE name = ?',
        args: [name]
      });
    } catch (error) {
      console.error('Failed to delete server config:', error);
      throw error;
    }
  }

  async getSelectedServer(): Promise<string> {
    await this.initialize();
    if (!this.client) throw new Error('Database not initialized');

    try {
      const result = await this.client.execute({
        sql: 'SELECT server_name FROM selected_server WHERE id = 1',
        args: []
      });

      if (result.rows.length > 0) {
        return result.rows[0].server_name as string || '';
      }
      return '';
    } catch (error) {
      console.warn('Failed to get selected server:', error);
      return '';
    }
  }

  async setSelectedServer(serverName: string): Promise<void> {
    await this.initialize();
    if (!this.client) throw new Error('Database not initialized');

    try {
      await this.client.execute({
        sql: `
          INSERT OR REPLACE INTO selected_server (id, server_name)
          VALUES (1, ?)
        `,
        args: [serverName]
      });
    } catch (error) {
      console.error('Failed to set selected server:', error);
      throw error;
    }
  }

  // User Preferences Methods
  async getUserPreferences(): Promise<UserPreferences> {
    await this.initialize();
    if (!this.client) throw new Error('Database not initialized');

    try {
      const result = await this.client.execute({
        sql: 'SELECT preferences_data FROM user_preferences WHERE id = 1',
        args: []
      });

      if (result.rows.length > 0) {
        const data = result.rows[0].preferences_data as string;
        return JSON.parse(data) as UserPreferences;
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

  async updateUserPreferences(preferences: Partial<UserPreferences>): Promise<void> {
    await this.initialize();
    if (!this.client) throw new Error('Database not initialized');

    try {
      const current = await this.getUserPreferences();
      const updated = { ...current, ...preferences };
      
      await this.client.execute({
        sql: `
          INSERT OR REPLACE INTO user_preferences (id, preferences_data)
          VALUES (1, ?)
        `,
        args: [JSON.stringify(updated)]
      });
    } catch (error) {
      console.error('Failed to update user preferences:', error);
      throw error;
    }
  }

  // Request History Methods
  async getAllRequestHistory(): Promise<McpJamRequest[]> {
    await this.initialize();
    if (!this.client) throw new Error('Database not initialized');

    try {
      const result = await this.client.execute({
        sql: 'SELECT request_data FROM request_history ORDER BY created_at DESC',
        args: []
      });

      const requests: McpJamRequest[] = [];
      
      for (const row of result.rows) {
        const data = row.request_data as string;
        const request = JSON.parse(data) as McpJamRequest;
        
        // Deserialize dates
        request.createdAt = new Date(request.createdAt);
        request.updatedAt = new Date(request.updatedAt);
        
        requests.push(request);
      }

      return requests;
    } catch (error) {
      console.warn('Failed to load request history:', error);
      return [];
    }
  }

  async addRequestHistory(request: McpJamRequest): Promise<void> {
    await this.initialize();
    if (!this.client) throw new Error('Database not initialized');

    try {
      const requestWithId = {
        ...request,
        id: request.id || this.generateId(),
        createdAt: request.createdAt || new Date(),
        updatedAt: new Date(),
      };

      await this.client.execute({
        sql: `
          INSERT INTO request_history (id, request_data)
          VALUES (?, ?)
        `,
        args: [requestWithId.id, JSON.stringify(requestWithId)]
      });
    } catch (error) {
      console.error('Failed to add request history:', error);
      throw error;
    }
  }

  async updateRequestHistory(id: string, updates: Partial<McpJamRequest>): Promise<void> {
    await this.initialize();
    if (!this.client) throw new Error('Database not initialized');

    try {
      const result = await this.client.execute({
        sql: 'SELECT request_data FROM request_history WHERE id = ?',
        args: [id]
      });

      if (result.rows.length > 0) {
        const data = result.rows[0].request_data as string;
        const current = JSON.parse(data) as McpJamRequest;
        
        const updated = {
          ...current,
          ...updates,
          updatedAt: new Date(),
        };

        await this.client.execute({
          sql: 'UPDATE request_history SET request_data = ? WHERE id = ?',
          args: [JSON.stringify(updated), id]
        });
      }
    } catch (error) {
      console.error('Failed to update request history:', error);
      throw error;
    }
  }

  async deleteRequestHistory(id: string): Promise<void> {
    await this.initialize();
    if (!this.client) throw new Error('Database not initialized');

    try {
      await this.client.execute({
        sql: 'DELETE FROM request_history WHERE id = ?',
        args: [id]
      });
    } catch (error) {
      console.error('Failed to delete request history:', error);
      throw error;
    }
  }

  async clearAllRequestHistory(): Promise<void> {
    await this.initialize();
    if (!this.client) throw new Error('Database not initialized');

    try {
      await this.client.execute({
        sql: 'DELETE FROM request_history',
        args: []
      });
    } catch (error) {
      console.error('Failed to clear request history:', error);
      throw error;
    }
  }

  // Debug method to inspect all database contents
  async debugDumpAll(): Promise<void> {
    console.group('🔍 LibSQL Database Contents');
    
    try {
      const serverConfigs = await this.getAllServerConfigs();
      console.log('📋 Server Configs:', serverConfigs);
      
      const requestHistory = await this.getAllRequestHistory();
      console.log('📝 Request History:', requestHistory);
      
      const userPreferences = await this.getUserPreferences();
      console.log('⚙️ User Preferences:', userPreferences);
      
      const selectedServer = await this.getSelectedServer();
      console.log('🎯 Selected Server:', selectedServer);
      
      // Get table stats
      if (this.client) {
        const serverCount = await this.client.execute({
          sql: 'SELECT COUNT(*) as count FROM server_configs',
          args: []
        });
        
        const requestCount = await this.client.execute({
          sql: 'SELECT COUNT(*) as count FROM request_history',
          args: []
        });
        
        console.log('📊 Database Stats:', {
          serverConfigs: serverCount.rows[0].count,
          requestHistory: requestCount.rows[0].count
        });
      }
      
    } catch (error) {
      console.error('Error dumping database:', error);
    }
    
    console.groupEnd();
  }
}

// Create database instance with environment-specific configuration
function createBrowserDatabaseConfig(): DatabaseConfig {
  // Check for environment variables or configuration
  const dbUrl = import.meta.env.VITE_DATABASE_URL;
  const dbToken = import.meta.env.VITE_DATABASE_TOKEN;
  
  if (dbUrl) {
    console.log('🔗 Using configured database URL:', dbUrl);
    return {
      url: dbUrl,
      authToken: dbToken,
    };
  }
  
  // For development, you can set up a local HTTP server or use Turso
  // For now, fallback to :memory: but log a warning
  console.warn('⚠️ No database URL configured. Using :memory: database.');
  console.warn('Set VITE_DATABASE_URL environment variable to share database between UI and CLI.');
  console.warn('Example: VITE_DATABASE_URL=https://your-db.turso.io or http://localhost:8080');
  
  return {};
}

// Create singleton instance with configuration
export const libsqlBrowserDatabase = new LibSQLBrowserDatabase(createBrowserDatabaseConfig()); 