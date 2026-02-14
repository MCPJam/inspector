import type { MCPServerConfig } from "@mcpjam/sdk/browser";

export interface ServerFormData {
  name: string;
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  useOAuth?: boolean;
  oauthScopes?: string[];
  clientId?: string;
  clientSecret?: string;
  requestTimeout?: number;
}

export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  client_id?: string;
  client_secret?: string;
}

export type ConnectionStatus =
  | "connected"
  | "connecting"
  | "failed"
  | "disconnected"
  | "oauth-flow";

export interface InitializationInfo {
  protocolVersion?: string;
  transport?: string;
  serverCapabilities?: Record<string, unknown>;
  serverVersion?: {
    name: string;
    version: string;
    title?: string;
    websiteUrl?: string;
    icons?: Array<{ src: string; mimeType?: string; sizes?: string[] }>;
  };
  instructions?: string;
  clientCapabilities?: Record<string, unknown>;
}

export interface ServerWithName {
  id: string;
  name: string;
  config: MCPServerConfig;
  oauthTokens?: OAuthTokens;
  initializationInfo?: InitializationInfo;
  lastConnectionTime: Date;
  connectionStatus: ConnectionStatus;
  retryCount: number;
  lastError?: string;
  useOAuth?: boolean;
}
