/**
 * Shared database types for MCP Jam Inspector
 * These types mirror the database schema and provide type safety
 */
import { Tool } from "@modelcontextprotocol/sdk/types.js";
export type JsonValue = string | number | boolean | null | JsonValue[] | {
    [key: string]: JsonValue;
};
export type TransportType = "stdio" | "sse" | "streamable-http";
export type Theme = "light" | "dark" | "system";
export type SessionType = "cli" | "ui" | "sdk";
export type ProviderType = "openai" | "anthropic" | "ollama";
export type ValueType = "string" | "number" | "boolean" | "json";
/**
 * Server configuration entity
 */
export interface ServerConfig {
    id: string;
    name: string;
    transportType: TransportType;
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
/**
 * Request history entity
 */
export interface RequestHistory {
    id: string;
    name: string;
    description?: string;
    toolName: string;
    toolDefinition: Tool;
    parameters: Record<string, JsonValue>;
    clientId: string;
    isFavorite?: boolean;
    tags?: string[];
    createdAt: Date;
    updatedAt: Date;
}
/**
 * User preferences entity
 */
export interface UserPreferences {
    id: number;
    theme: Theme;
    uiLayout?: Record<string, unknown>;
    paneHeights?: Record<string, number>;
    autoOpenEnabled?: boolean;
    hasSeenStarModal?: boolean;
    createdAt: Date;
    updatedAt: Date;
}
/**
 * Provider configuration entity
 */
export interface ProviderConfig {
    id: string;
    providerType: ProviderType;
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    configuration?: Record<string, unknown>;
    isActive?: boolean;
    createdAt: Date;
    updatedAt: Date;
}
/**
 * Application setting entity
 */
export interface AppSetting {
    key: string;
    value: string;
    valueType: ValueType;
    description?: string;
    createdAt: Date;
    updatedAt: Date;
}
/**
 * Session entity
 */
export interface Session {
    id: string;
    sessionType: SessionType;
    selectedServerId?: string;
    lastCommand?: string;
    lastArgs?: string;
    lastSseUrl?: string;
    lastTransportType?: string;
    lastBearerToken?: string;
    lastHeaderName?: string;
    startedAt: Date;
    endedAt?: Date;
}
/**
 * Input types for creating entities
 */
export interface CreateServerConfigInput {
    name: string;
    transportType: TransportType;
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
}
export interface CreateRequestHistoryInput {
    name: string;
    description?: string;
    toolName: string;
    toolDefinition: Tool;
    parameters: Record<string, JsonValue>;
    clientId: string;
    isFavorite?: boolean;
    tags?: string[];
}
export interface CreateProviderConfigInput {
    providerType: ProviderType;
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    configuration?: Record<string, unknown>;
    isActive?: boolean;
}
export interface CreateSessionInput {
    sessionType: SessionType;
    selectedServerId?: string;
    lastCommand?: string;
    lastArgs?: string;
    lastSseUrl?: string;
    lastTransportType?: string;
    lastBearerToken?: string;
    lastHeaderName?: string;
}
/**
 * Update types (all fields optional)
 */
export interface UpdateServerConfigInput extends Partial<CreateServerConfigInput> {
}
export interface UpdateRequestHistoryInput extends Partial<Omit<CreateRequestHistoryInput, 'clientId'>> {
}
export interface UpdateUserPreferencesInput extends Partial<Omit<UserPreferences, 'id' | 'createdAt' | 'updatedAt'>> {
}
export interface UpdateProviderConfigInput extends Partial<CreateProviderConfigInput> {
}
export interface UpdateAppSettingInput {
    value?: string;
    valueType?: ValueType;
    description?: string;
}
export interface UpdateSessionInput extends Partial<CreateSessionInput> {
    endedAt?: Date;
}
/**
 * Filter types for queries
 */
export interface ServerConfigFilter {
    transportType?: TransportType;
    name?: string;
}
export interface RequestHistoryFilter {
    clientId?: string;
    toolName?: string;
    isFavorite?: boolean;
    tags?: string[];
}
export interface ProviderConfigFilter {
    providerType?: ProviderType;
    isActive?: boolean;
}
export interface SessionFilter {
    sessionType?: SessionType;
    selectedServerId?: string;
}
/**
 * Result types for pagination
 */
export interface PaginationOptions {
    limit?: number;
    offset?: number;
    orderBy?: string;
    orderDirection?: 'ASC' | 'DESC';
}
export interface PaginatedResult<T> {
    items: T[];
    total: number;
    hasMore: boolean;
}
