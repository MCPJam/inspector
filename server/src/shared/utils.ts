import { randomUUID } from 'node:crypto';
import { ServerConfig, Logger } from './types.js';

export function generateSessionId(): string {
  return randomUUID();
}

export function validateServerConfig(config: ServerConfig): void {
  if (!config.id || !config.type || !config.name) {
    throw new Error('Invalid server configuration: id, type, and name are required');
  }
  
  if (config.type === 'stdio' && !config.command) {
    throw new Error('STDIO transport requires command');
  }
  
  if ((config.type === 'sse' || config.type === 'streamable-http') && !config.url) {
    throw new Error('SSE and HTTP transports require URL');
  }
}

export function sanitizeEnvironment(env: Record<string, string> = {}): Record<string, string> {
  const sanitized: Record<string, string> = {};
  
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      sanitized[key] = value;
    }
  }
  
  return sanitized;
}

export function createServerConfigFromQuery(query: Record<string, any>): ServerConfig {
  const transportType = query.transportType as string;
  
  const config: ServerConfig = {
    id: query.id || generateSessionId(),
    type: transportType as 'stdio' | 'sse' | 'streamable-http',
    name: query.name || `${transportType}-server`,
  };

  if (transportType === 'stdio') {
    config.command = query.command as string;
    config.args = query.args ? JSON.parse(query.args) : [];
    config.env = query.env ? JSON.parse(query.env) : {};
  } else if (transportType === 'sse' || transportType === 'streamable-http') {
    config.url = query.url as string;
    config.headers = query.headers ? JSON.parse(query.headers) : {};
  }

  return config;
}

export class ConsoleLogger implements Logger {
  private prefix: string;

  constructor(prefix: string = 'MCPProxy') {
    this.prefix = prefix;
  }

  info(message: string, ...args: any[]): void {
    console.log(`[${this.prefix}] ${message}`, ...args);
  }
  
  error(message: string, ...args: any[]): void {
    console.error(`[${this.prefix}] ${message}`, ...args);
  }
  
  warn(message: string, ...args: any[]): void {
    console.warn(`[${this.prefix}] ${message}`, ...args);
  }
  
  debug(message: string, ...args: any[]): void {
    if (process.env.NODE_ENV === 'development' || process.env.DEBUG) {
      console.debug(`[${this.prefix}] ${message}`, ...args);
    }
  }
}

export function isTransportError(error: any): boolean {
  return error?.message?.includes('Error POSTing to endpoint') ||
         error?.cause && JSON.stringify(error.cause).includes('ECONNREFUSED');
}

export function createTransportErrorMessage(error: any): string {
  if (isTransportError(error)) {
    return 'Connection refused. Is the MCP server running?';
  }
  return error?.message || 'Unknown transport error';
}