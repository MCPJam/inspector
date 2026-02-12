import { createContext } from "react";
import type { MCPClientManager } from "@mcpjam/sdk/browser";

export type MCPConnectionStatus =
  | "connected"
  | "connecting"
  | "disconnected"
  | "oauth-pending"
  | "error";

export type MCPTransportType = "streamable-http" | "sse";

export interface MCPOAuthConfig {
  enabled: boolean;
  scopes?: string[];
  clientId?: string;
  clientSecret?: string;
}

export interface MCPConnectionError {
  code?: string;
  message: string;
  retryable: boolean;
}

export interface MCPServerConnection {
  id: string;
  name: string;
  url: string;
  transport: MCPTransportType;
  headers?: Record<string, string>;
  oauth?: MCPOAuthConfig;
  sessionId?: string;
  connectionStatus: MCPConnectionStatus;
  createdAt: string;
  lastConnectedAt?: string;
  retryCount: number;
  initializationInfo?: unknown;
  serverCapabilities?: unknown;
  lastError?: MCPConnectionError;
}

export interface ConnectServerInput {
  id?: string;
  name: string;
  url: string;
  transport?: MCPTransportType;
  headers?: Record<string, string>;
  oauth?: MCPOAuthConfig;
  sessionId?: string;
  accessToken?: string;
}

export interface McpConnectionsContextValue {
  servers: MCPServerConnection[];
  connectServer: (input: ConnectServerInput) => Promise<void>;
  disconnectServer: (serverId: string) => Promise<void>;
  reconnectServer: (serverId: string) => Promise<void>;
  removeServer: (serverId: string) => Promise<void>;
  refreshServerCapabilities: (serverId: string) => Promise<void>;
  activeServerId: string | null;
  setActiveServerId: (id: string | null) => void;
  getManager: () => MCPClientManager | null;
}

export const McpConnectionsContext =
  createContext<McpConnectionsContextValue | null>(null);
