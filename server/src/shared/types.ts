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
}

export interface ConnectionStatus {
  id: string;
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  lastActivity: Date;
  errorCount: number;
}

export interface TransportFactoryOptions {
  logger?: Logger;
  defaultTimeout?: number;
}

export interface Logger {
  info(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
}