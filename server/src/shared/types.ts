export interface ServerConfig {
  id: string;
  type: 'stdio' | 'sse' | 'streamable-http';
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface MCPProxyOptions {
  logger?: Logger;
  maxConnections?: number;
  connectionTimeout?: number;
  retryAttempts?: number;
  defaultEnvironment?: Record<string, string>;
}

export interface ConnectionStatus {
  id: string;
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  lastActivity: Date;
  errorCount: number;
  serverConfig?: ServerConfig;
}

export interface TransportFactoryOptions {
  logger?: Logger;
  defaultTimeout?: number;
  defaultEnvironment?: Record<string, string>;
}

export interface Logger {
  info(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  debug?(message: string, ...args: any[]): void;
}

export interface ProxyConnectionInfo {
  sessionId: string;
  serverConfig: ServerConfig;
  clientTransport: any; // Transport from client
  serverTransport: any; // Transport to MCP server
  status: ConnectionStatus;
  createdAt: Date;
}

export interface TransportCreationRequest {
  serverConfig: ServerConfig;
  headers?: Record<string, string>;
  environment?: Record<string, string>;
}