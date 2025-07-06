/**
 * MCP Jam Inspector Shared Database Access Layer
 * Provides unified access to the shared libSQL database for CLI, SDK, and UI
 */
import { ServerConfig, RequestHistory, UserPreferences, ProviderConfig, AppSetting, Session, CreateServerConfigInput, CreateRequestHistoryInput, CreateProviderConfigInput, CreateSessionInput, UpdateServerConfigInput, UpdateRequestHistoryInput, UpdateUserPreferencesInput, UpdateProviderConfigInput, UpdateSessionInput, ServerConfigFilter, RequestHistoryFilter, ProviderConfigFilter, PaginationOptions, PaginatedResult } from "./types";
export interface DatabaseConfig {
    url?: string;
    authToken?: string;
    localPath?: string;
    syncUrl?: string;
    syncToken?: string;
}
export declare class MCPJamDatabase {
    private client;
    private initialized;
    private config?;
    constructor(config?: DatabaseConfig);
    private getClient;
    /**
     * Initialize the database by creating tables and setting up schema
     */
    initialize(): Promise<void>;
    /**
     * Close the database connection
     */
    close(): Promise<void>;
    createServerConfig(input: CreateServerConfigInput): Promise<ServerConfig>;
    getServerConfig(id: string): Promise<ServerConfig>;
    getAllServerConfigs(filter?: ServerConfigFilter): Promise<ServerConfig[]>;
    updateServerConfig(id: string, input: UpdateServerConfigInput): Promise<ServerConfig>;
    deleteServerConfig(id: string): Promise<void>;
    createRequestHistory(input: CreateRequestHistoryInput): Promise<RequestHistory>;
    getRequestHistory(id: string): Promise<RequestHistory>;
    getAllRequestHistory(filter?: RequestHistoryFilter, pagination?: PaginationOptions): Promise<PaginatedResult<RequestHistory>>;
    updateRequestHistory(id: string, input: UpdateRequestHistoryInput): Promise<RequestHistory>;
    deleteRequestHistory(id: string): Promise<void>;
    getUserPreferences(): Promise<UserPreferences>;
    updateUserPreferences(input: UpdateUserPreferencesInput): Promise<UserPreferences>;
    createProviderConfig(input: CreateProviderConfigInput): Promise<ProviderConfig>;
    getProviderConfig(id: string): Promise<ProviderConfig>;
    getAllProviderConfigs(filter?: ProviderConfigFilter): Promise<ProviderConfig[]>;
    updateProviderConfig(id: string, input: UpdateProviderConfigInput): Promise<ProviderConfig>;
    deleteProviderConfig(id: string): Promise<void>;
    getAppSetting(key: string): Promise<AppSetting>;
    getAllAppSettings(): Promise<AppSetting[]>;
    setAppSetting(key: string, value: string, valueType: string, description?: string): Promise<AppSetting>;
    deleteAppSetting(key: string): Promise<void>;
    createSession(input: CreateSessionInput): Promise<Session>;
    getSession(id: string): Promise<Session>;
    getCurrentSession(sessionType: string): Promise<Session | null>;
    updateSession(id: string, input: UpdateSessionInput): Promise<Session>;
    endSession(id: string): Promise<Session>;
    private mapServerConfigRow;
    private mapRequestHistoryRow;
    private mapUserPreferencesRow;
    private mapProviderConfigRow;
    private mapAppSettingRow;
    private mapSessionRow;
}
export declare const database: MCPJamDatabase;
export declare const initializeDatabase: () => Promise<void>;
export declare const closeDatabase: () => Promise<void>;
