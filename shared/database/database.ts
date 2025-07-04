/**
 * MCP Jam Inspector Shared Database Access Layer
 * Provides unified access to the shared libSQL database for CLI, SDK, and UI
 */

import { createClient, Client } from "@libsql/client";
import { randomUUID } from "crypto";
import { homedir } from "os";
import { join } from "path";
import { readFileSync } from "fs";
import { mkdir } from "fs/promises";
import {
  ServerConfig,
  RequestHistory,
  UserPreferences,
  ProviderConfig,
  AppSetting,
  Session,
  CreateServerConfigInput,
  CreateRequestHistoryInput,
  CreateProviderConfigInput,
  CreateSessionInput,
  UpdateServerConfigInput,
  UpdateRequestHistoryInput,
  UpdateUserPreferencesInput,
  UpdateProviderConfigInput,
  UpdateAppSettingInput,
  UpdateSessionInput,
  ServerConfigFilter,
  RequestHistoryFilter,
  ProviderConfigFilter,
  SessionFilter,
  PaginationOptions,
  PaginatedResult,
} from "./types";

export interface DatabaseConfig {
  url?: string;           // For remote libSQL/Turso
  authToken?: string;     // For authentication with Turso
  localPath?: string;     // For local SQLite file
  syncUrl?: string;       // For sync with remote database
  syncToken?: string;     // For sync authentication
}

export class MCPJamDatabase {
  private client: Client;
  private initialized = false;

  constructor(config?: DatabaseConfig) {
    const defaultLocalPath = join(homedir(), '.mcpjam', 'data.db');
    
    if (config?.url) {
      // Remote database (Turso)
      this.client = createClient({
        url: config.url,
        authToken: config.authToken,
      });
    } else {
      // Local database
      this.client = createClient({
        url: `file:${config?.localPath || defaultLocalPath}`,
      });
    }
  }

  /**
   * Initialize the database by creating tables and setting up schema
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Ensure the .mcpjam directory exists
      const dbDir = join(homedir(), '.mcpjam');
      await mkdir(dbDir, { recursive: true });

      // Read and execute schema
      const schemaPath = join(__dirname, 'schema.sql');
      const schema = readFileSync(schemaPath, 'utf8');
      
      await this.client.execute(schema);
      this.initialized = true;
    } catch (error) {
      console.error('Failed to initialize database:', error);
      throw error;
    }
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    await this.client.close();
  }

  // SERVER CONFIGS
  async createServerConfig(input: CreateServerConfigInput): Promise<ServerConfig> {
    await this.initialize();
    
    const id = randomUUID();
    const now = new Date().toISOString();
    
    await this.client.execute({
      sql: `INSERT INTO server_configs (
        id, name, transport_type, command, args, env, url, request_init, 
        event_source_init, reconnection_options, session_id, timeout, 
        capabilities, enable_server_logs, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        input.name,
        input.transportType,
        input.command || null,
        input.args ? JSON.stringify(input.args) : null,
        input.env ? JSON.stringify(input.env) : null,
        input.url || null,
        input.requestInit ? JSON.stringify(input.requestInit) : null,
        input.eventSourceInit ? JSON.stringify(input.eventSourceInit) : null,
        input.reconnectionOptions ? JSON.stringify(input.reconnectionOptions) : null,
        input.sessionId || null,
        input.timeout || 30000,
        input.capabilities ? JSON.stringify(input.capabilities) : null,
        input.enableServerLogs || false,
        now,
        now,
      ],
    });

    return this.getServerConfig(id);
  }

  async getServerConfig(id: string): Promise<ServerConfig> {
    await this.initialize();
    
    const result = await this.client.execute({
      sql: "SELECT * FROM server_configs WHERE id = ?",
      args: [id],
    });

    if (result.rows.length === 0) {
      throw new Error(`Server config not found: ${id}`);
    }

    return this.mapServerConfigRow(result.rows[0]);
  }

  async getAllServerConfigs(filter?: ServerConfigFilter): Promise<ServerConfig[]> {
    await this.initialize();
    
    let sql = "SELECT * FROM server_configs";
    const args: any[] = [];

    if (filter) {
      const conditions: string[] = [];
      
      if (filter.transportType) {
        conditions.push("transport_type = ?");
        args.push(filter.transportType);
      }
      
      if (filter.name) {
        conditions.push("name LIKE ?");
        args.push(`%${filter.name}%`);
      }
      
      if (conditions.length > 0) {
        sql += " WHERE " + conditions.join(" AND ");
      }
    }

    sql += " ORDER BY created_at DESC";

    const result = await this.client.execute({ sql, args });
    return result.rows.map(row => this.mapServerConfigRow(row));
  }

  async updateServerConfig(id: string, input: UpdateServerConfigInput): Promise<ServerConfig> {
    await this.initialize();
    
    const updates: string[] = [];
    const args: any[] = [];

    if (input.name !== undefined) {
      updates.push("name = ?");
      args.push(input.name);
    }
    
    if (input.transportType !== undefined) {
      updates.push("transport_type = ?");
      args.push(input.transportType);
    }
    
    if (input.command !== undefined) {
      updates.push("command = ?");
      args.push(input.command);
    }
    
    if (input.args !== undefined) {
      updates.push("args = ?");
      args.push(input.args ? JSON.stringify(input.args) : null);
    }
    
    if (input.env !== undefined) {
      updates.push("env = ?");
      args.push(input.env ? JSON.stringify(input.env) : null);
    }
    
    if (input.url !== undefined) {
      updates.push("url = ?");
      args.push(input.url);
    }
    
    if (input.timeout !== undefined) {
      updates.push("timeout = ?");
      args.push(input.timeout);
    }
    
    if (input.enableServerLogs !== undefined) {
      updates.push("enable_server_logs = ?");
      args.push(input.enableServerLogs);
    }

    if (updates.length === 0) {
      throw new Error("No updates provided");
    }

    updates.push("updated_at = ?");
    args.push(new Date().toISOString());
    args.push(id);

    await this.client.execute({
      sql: `UPDATE server_configs SET ${updates.join(", ")} WHERE id = ?`,
      args,
    });

    return this.getServerConfig(id);
  }

  async deleteServerConfig(id: string): Promise<void> {
    await this.initialize();
    
    await this.client.execute({
      sql: "DELETE FROM server_configs WHERE id = ?",
      args: [id],
    });
  }

  // REQUEST HISTORY
  async createRequestHistory(input: CreateRequestHistoryInput): Promise<RequestHistory> {
    await this.initialize();
    
    const id = randomUUID();
    const now = new Date().toISOString();
    
    await this.client.execute({
      sql: `INSERT INTO request_history (
        id, name, description, tool_name, tool_definition, parameters, 
        client_id, is_favorite, tags, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        input.name,
        input.description || null,
        input.toolName,
        JSON.stringify(input.toolDefinition),
        JSON.stringify(input.parameters),
        input.clientId,
        input.isFavorite || false,
        input.tags ? JSON.stringify(input.tags) : null,
        now,
        now,
      ],
    });

    return this.getRequestHistory(id);
  }

  async getRequestHistory(id: string): Promise<RequestHistory> {
    await this.initialize();
    
    const result = await this.client.execute({
      sql: "SELECT * FROM request_history WHERE id = ?",
      args: [id],
    });

    if (result.rows.length === 0) {
      throw new Error(`Request history not found: ${id}`);
    }

    return this.mapRequestHistoryRow(result.rows[0]);
  }

  async getAllRequestHistory(
    filter?: RequestHistoryFilter,
    pagination?: PaginationOptions
  ): Promise<PaginatedResult<RequestHistory>> {
    await this.initialize();
    
    let sql = "SELECT * FROM request_history";
    const args: any[] = [];

    if (filter) {
      const conditions: string[] = [];
      
      if (filter.clientId) {
        conditions.push("client_id = ?");
        args.push(filter.clientId);
      }
      
      if (filter.toolName) {
        conditions.push("tool_name = ?");
        args.push(filter.toolName);
      }
      
      if (filter.isFavorite !== undefined) {
        conditions.push("is_favorite = ?");
        args.push(filter.isFavorite);
      }
      
      if (conditions.length > 0) {
        sql += " WHERE " + conditions.join(" AND ");
      }
    }

    // Get total count
    const countResult = await this.client.execute({
      sql: sql.replace("SELECT *", "SELECT COUNT(*) as count"),
      args,
    });
    const total = Number(countResult.rows[0].count);

    // Apply pagination
    const orderBy = pagination?.orderBy || "created_at";
    const orderDirection = pagination?.orderDirection || "DESC";
    sql += ` ORDER BY ${orderBy} ${orderDirection}`;

    if (pagination?.limit) {
      sql += ` LIMIT ${pagination.limit}`;
      if (pagination.offset) {
        sql += ` OFFSET ${pagination.offset}`;
      }
    }

    const result = await this.client.execute({ sql, args });
    const items = result.rows.map(row => this.mapRequestHistoryRow(row));

    return {
      items,
      total,
      hasMore: (pagination?.offset || 0) + items.length < total,
    };
  }

  async updateRequestHistory(id: string, input: UpdateRequestHistoryInput): Promise<RequestHistory> {
    await this.initialize();
    
    const updates: string[] = [];
    const args: any[] = [];

    if (input.name !== undefined) {
      updates.push("name = ?");
      args.push(input.name);
    }
    
    if (input.description !== undefined) {
      updates.push("description = ?");
      args.push(input.description);
    }
    
    if (input.parameters !== undefined) {
      updates.push("parameters = ?");
      args.push(JSON.stringify(input.parameters));
    }
    
    if (input.isFavorite !== undefined) {
      updates.push("is_favorite = ?");
      args.push(input.isFavorite);
    }
    
    if (input.tags !== undefined) {
      updates.push("tags = ?");
      args.push(input.tags ? JSON.stringify(input.tags) : null);
    }

    if (updates.length === 0) {
      throw new Error("No updates provided");
    }

    updates.push("updated_at = ?");
    args.push(new Date().toISOString());
    args.push(id);

    await this.client.execute({
      sql: `UPDATE request_history SET ${updates.join(", ")} WHERE id = ?`,
      args,
    });

    return this.getRequestHistory(id);
  }

  async deleteRequestHistory(id: string): Promise<void> {
    await this.initialize();
    
    await this.client.execute({
      sql: "DELETE FROM request_history WHERE id = ?",
      args: [id],
    });
  }

  // USER PREFERENCES
  async getUserPreferences(): Promise<UserPreferences> {
    await this.initialize();
    
    const result = await this.client.execute({
      sql: "SELECT * FROM user_preferences WHERE id = 1",
      args: [],
    });

    if (result.rows.length === 0) {
      throw new Error("User preferences not found");
    }

    return this.mapUserPreferencesRow(result.rows[0]);
  }

  async updateUserPreferences(input: UpdateUserPreferencesInput): Promise<UserPreferences> {
    await this.initialize();
    
    const updates: string[] = [];
    const args: any[] = [];

    if (input.theme !== undefined) {
      updates.push("theme = ?");
      args.push(input.theme);
    }
    
    if (input.uiLayout !== undefined) {
      updates.push("ui_layout = ?");
      args.push(input.uiLayout ? JSON.stringify(input.uiLayout) : null);
    }
    
    if (input.paneHeights !== undefined) {
      updates.push("pane_heights = ?");
      args.push(input.paneHeights ? JSON.stringify(input.paneHeights) : null);
    }
    
    if (input.autoOpenEnabled !== undefined) {
      updates.push("auto_open_enabled = ?");
      args.push(input.autoOpenEnabled);
    }
    
    if (input.hasSeenStarModal !== undefined) {
      updates.push("has_seen_star_modal = ?");
      args.push(input.hasSeenStarModal);
    }

    if (updates.length === 0) {
      throw new Error("No updates provided");
    }

    updates.push("updated_at = ?");
    args.push(new Date().toISOString());

    await this.client.execute({
      sql: `UPDATE user_preferences SET ${updates.join(", ")} WHERE id = 1`,
      args,
    });

    return this.getUserPreferences();
  }

  // PROVIDER CONFIGS
  async createProviderConfig(input: CreateProviderConfigInput): Promise<ProviderConfig> {
    await this.initialize();
    
    const id = randomUUID();
    const now = new Date().toISOString();
    
    await this.client.execute({
      sql: `INSERT INTO provider_configs (
        id, provider_type, api_key, base_url, model, configuration, 
        is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        input.providerType,
        input.apiKey || null,
        input.baseUrl || null,
        input.model || null,
        input.configuration ? JSON.stringify(input.configuration) : null,
        input.isActive !== undefined ? input.isActive : true,
        now,
        now,
      ],
    });

    return this.getProviderConfig(id);
  }

  async getProviderConfig(id: string): Promise<ProviderConfig> {
    await this.initialize();
    
    const result = await this.client.execute({
      sql: "SELECT * FROM provider_configs WHERE id = ?",
      args: [id],
    });

    if (result.rows.length === 0) {
      throw new Error(`Provider config not found: ${id}`);
    }

    return this.mapProviderConfigRow(result.rows[0]);
  }

  async getAllProviderConfigs(filter?: ProviderConfigFilter): Promise<ProviderConfig[]> {
    await this.initialize();
    
    let sql = "SELECT * FROM provider_configs";
    const args: any[] = [];

    if (filter) {
      const conditions: string[] = [];
      
      if (filter.providerType) {
        conditions.push("provider_type = ?");
        args.push(filter.providerType);
      }
      
      if (filter.isActive !== undefined) {
        conditions.push("is_active = ?");
        args.push(filter.isActive);
      }
      
      if (conditions.length > 0) {
        sql += " WHERE " + conditions.join(" AND ");
      }
    }

    sql += " ORDER BY created_at DESC";

    const result = await this.client.execute({ sql, args });
    return result.rows.map(row => this.mapProviderConfigRow(row));
  }

  async updateProviderConfig(id: string, input: UpdateProviderConfigInput): Promise<ProviderConfig> {
    await this.initialize();
    
    const updates: string[] = [];
    const args: any[] = [];

    if (input.apiKey !== undefined) {
      updates.push("api_key = ?");
      args.push(input.apiKey);
    }
    
    if (input.baseUrl !== undefined) {
      updates.push("base_url = ?");
      args.push(input.baseUrl);
    }
    
    if (input.model !== undefined) {
      updates.push("model = ?");
      args.push(input.model);
    }
    
    if (input.configuration !== undefined) {
      updates.push("configuration = ?");
      args.push(input.configuration ? JSON.stringify(input.configuration) : null);
    }
    
    if (input.isActive !== undefined) {
      updates.push("is_active = ?");
      args.push(input.isActive);
    }

    if (updates.length === 0) {
      throw new Error("No updates provided");
    }

    updates.push("updated_at = ?");
    args.push(new Date().toISOString());
    args.push(id);

    await this.client.execute({
      sql: `UPDATE provider_configs SET ${updates.join(", ")} WHERE id = ?`,
      args,
    });

    return this.getProviderConfig(id);
  }

  async deleteProviderConfig(id: string): Promise<void> {
    await this.initialize();
    
    await this.client.execute({
      sql: "DELETE FROM provider_configs WHERE id = ?",
      args: [id],
    });
  }

  // APP SETTINGS
  async getAppSetting(key: string): Promise<AppSetting> {
    await this.initialize();
    
    const result = await this.client.execute({
      sql: "SELECT * FROM app_settings WHERE key = ?",
      args: [key],
    });

    if (result.rows.length === 0) {
      throw new Error(`App setting not found: ${key}`);
    }

    return this.mapAppSettingRow(result.rows[0]);
  }

  async getAllAppSettings(): Promise<AppSetting[]> {
    await this.initialize();
    
    const result = await this.client.execute({
      sql: "SELECT * FROM app_settings ORDER BY key",
      args: [],
    });

    return result.rows.map(row => this.mapAppSettingRow(row));
  }

  async setAppSetting(key: string, value: string, valueType: string, description?: string): Promise<AppSetting> {
    await this.initialize();
    
    const now = new Date().toISOString();
    
    await this.client.execute({
      sql: `INSERT OR REPLACE INTO app_settings (key, value, value_type, description, created_at, updated_at) 
            VALUES (?, ?, ?, ?, COALESCE((SELECT created_at FROM app_settings WHERE key = ?), ?), ?)`,
      args: [key, value, valueType, description || null, key, now, now],
    });

    return this.getAppSetting(key);
  }

  async deleteAppSetting(key: string): Promise<void> {
    await this.initialize();
    
    await this.client.execute({
      sql: "DELETE FROM app_settings WHERE key = ?",
      args: [key],
    });
  }

  // SESSIONS
  async createSession(input: CreateSessionInput): Promise<Session> {
    await this.initialize();
    
    const id = randomUUID();
    const now = new Date().toISOString();
    
    await this.client.execute({
      sql: `INSERT INTO sessions (
        id, session_type, selected_server_id, last_command, last_args, 
        last_sse_url, last_transport_type, last_bearer_token, last_header_name, 
        started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        input.sessionType,
        input.selectedServerId || null,
        input.lastCommand || null,
        input.lastArgs || null,
        input.lastSseUrl || null,
        input.lastTransportType || null,
        input.lastBearerToken || null,
        input.lastHeaderName || null,
        now,
      ],
    });

    return this.getSession(id);
  }

  async getSession(id: string): Promise<Session> {
    await this.initialize();
    
    const result = await this.client.execute({
      sql: "SELECT * FROM sessions WHERE id = ?",
      args: [id],
    });

    if (result.rows.length === 0) {
      throw new Error(`Session not found: ${id}`);
    }

    return this.mapSessionRow(result.rows[0]);
  }

  async getCurrentSession(sessionType: string): Promise<Session | null> {
    await this.initialize();
    
    const result = await this.client.execute({
      sql: "SELECT * FROM sessions WHERE session_type = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
      args: [sessionType],
    });

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapSessionRow(result.rows[0]);
  }

  async updateSession(id: string, input: UpdateSessionInput): Promise<Session> {
    await this.initialize();
    
    const updates: string[] = [];
    const args: any[] = [];

    if (input.selectedServerId !== undefined) {
      updates.push("selected_server_id = ?");
      args.push(input.selectedServerId);
    }
    
    if (input.lastCommand !== undefined) {
      updates.push("last_command = ?");
      args.push(input.lastCommand);
    }
    
    if (input.lastArgs !== undefined) {
      updates.push("last_args = ?");
      args.push(input.lastArgs);
    }
    
    if (input.lastSseUrl !== undefined) {
      updates.push("last_sse_url = ?");
      args.push(input.lastSseUrl);
    }
    
    if (input.lastTransportType !== undefined) {
      updates.push("last_transport_type = ?");
      args.push(input.lastTransportType);
    }
    
    if (input.lastBearerToken !== undefined) {
      updates.push("last_bearer_token = ?");
      args.push(input.lastBearerToken);
    }
    
    if (input.lastHeaderName !== undefined) {
      updates.push("last_header_name = ?");
      args.push(input.lastHeaderName);
    }
    
    if (input.endedAt !== undefined) {
      updates.push("ended_at = ?");
      args.push(input.endedAt?.toISOString() || null);
    }

    if (updates.length === 0) {
      throw new Error("No updates provided");
    }

    args.push(id);

    await this.client.execute({
      sql: `UPDATE sessions SET ${updates.join(", ")} WHERE id = ?`,
      args,
    });

    return this.getSession(id);
  }

  async endSession(id: string): Promise<Session> {
    return this.updateSession(id, { endedAt: new Date() });
  }

  // HELPER METHODS FOR MAPPING DATABASE ROWS TO TYPES
  private mapServerConfigRow(row: any): ServerConfig {
    return {
      id: row.id,
      name: row.name,
      transportType: row.transport_type,
      command: row.command,
      args: row.args ? JSON.parse(row.args) : undefined,
      env: row.env ? JSON.parse(row.env) : undefined,
      url: row.url,
      requestInit: row.request_init ? JSON.parse(row.request_init) : undefined,
      eventSourceInit: row.event_source_init ? JSON.parse(row.event_source_init) : undefined,
      reconnectionOptions: row.reconnection_options ? JSON.parse(row.reconnection_options) : undefined,
      sessionId: row.session_id,
      timeout: row.timeout,
      capabilities: row.capabilities ? JSON.parse(row.capabilities) : undefined,
      enableServerLogs: row.enable_server_logs,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  private mapRequestHistoryRow(row: any): RequestHistory {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      toolName: row.tool_name,
      toolDefinition: JSON.parse(row.tool_definition),
      parameters: JSON.parse(row.parameters),
      clientId: row.client_id,
      isFavorite: row.is_favorite,
      tags: row.tags ? JSON.parse(row.tags) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  private mapUserPreferencesRow(row: any): UserPreferences {
    return {
      id: row.id,
      theme: row.theme,
      uiLayout: row.ui_layout ? JSON.parse(row.ui_layout) : undefined,
      paneHeights: row.pane_heights ? JSON.parse(row.pane_heights) : undefined,
      autoOpenEnabled: row.auto_open_enabled,
      hasSeenStarModal: row.has_seen_star_modal,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  private mapProviderConfigRow(row: any): ProviderConfig {
    return {
      id: row.id,
      providerType: row.provider_type,
      apiKey: row.api_key,
      baseUrl: row.base_url,
      model: row.model,
      configuration: row.configuration ? JSON.parse(row.configuration) : undefined,
      isActive: row.is_active,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  private mapAppSettingRow(row: any): AppSetting {
    return {
      key: row.key,
      value: row.value,
      valueType: row.value_type,
      description: row.description,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  private mapSessionRow(row: any): Session {
    return {
      id: row.id,
      sessionType: row.session_type,
      selectedServerId: row.selected_server_id,
      lastCommand: row.last_command,
      lastArgs: row.last_args,
      lastSseUrl: row.last_sse_url,
      lastTransportType: row.last_transport_type,
      lastBearerToken: row.last_bearer_token,
      lastHeaderName: row.last_header_name,
      startedAt: new Date(row.started_at),
      endedAt: row.ended_at ? new Date(row.ended_at) : undefined,
    };
  }
}

// Create database instance with environment-specific configuration
function createDatabaseConfig(): DatabaseConfig {
  // Check for environment variables
  const dbUrl = process.env.DATABASE_URL;
  const dbToken = process.env.DATABASE_TOKEN;
  
  if (dbUrl) {
    console.log('🔗 Using configured database URL:', dbUrl);
    return {
      url: dbUrl,
      authToken: dbToken,
    };
  }
  
  // Default for CLI: use local file database
  return {};
}

// Export singleton instance with configuration
export const database = new MCPJamDatabase(createDatabaseConfig());

// Export convenience functions
export const initializeDatabase = () => database.initialize();
export const closeDatabase = () => database.close(); 