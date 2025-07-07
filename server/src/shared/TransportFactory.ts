import {
  SSEClientTransport,
  SseError,
} from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { parse as shellParseArgs } from 'shell-quote';
import { findActualExecutable } from 'spawn-rx';
import { 
  ServerConfig, 
  TransportFactoryOptions, 
  Logger, 
  TransportCreationRequest 
} from './types.js';
import { 
  validateServerConfig, 
  sanitizeEnvironment, 
  ConsoleLogger,
  createTransportErrorMessage 
} from './utils.js';

export class TransportFactory {
  private logger: Logger;
  private defaultTimeout: number;
  private defaultEnvironment: Record<string, string>;

  constructor(options: TransportFactoryOptions = {}) {
    this.logger = options.logger || new ConsoleLogger('TransportFactory');
    this.defaultTimeout = options.defaultTimeout || 10000;
    this.defaultEnvironment = options.defaultEnvironment || {};
  }

  async createTransport(request: TransportCreationRequest): Promise<Transport> {
    const { serverConfig, headers = {}, environment = {} } = request;
    
    validateServerConfig(serverConfig);
    
    this.logger.info(`Creating ${serverConfig.type} transport for ${serverConfig.name}`);
    
    try {
      switch (serverConfig.type) {
        case 'stdio':
          return await this.createStdioTransport(serverConfig, environment);
        case 'sse':
          return await this.createSSETransport(serverConfig, headers);
        case 'streamable-http':
          return await this.createStreamableHTTPTransport(serverConfig, headers);
        default:
          throw new Error(`Unsupported transport type: ${serverConfig.type}`);
      }
    } catch (error) {
      const errorMessage = createTransportErrorMessage(error);
      this.logger.error(`Failed to create transport for ${serverConfig.name}:`, errorMessage);
      
      // Re-throw SSE errors with proper codes for authentication handling
      if (error instanceof SseError) {
        throw error;
      }
      
      throw new Error(`Transport creation failed: ${errorMessage}`);
    }
  }

  private async createStdioTransport(config: ServerConfig, environment: Record<string, string>): Promise<Transport> {
    if (!config.command) {
      throw new Error('STDIO transport requires command');
    }

    const args = Array.isArray(config.args) ? config.args : 
                 typeof config.args === 'string' ? shellParseArgs(config.args) as string[] : [];
    
    const env: Record<string, string> = {
      ...getDefaultEnvironment(),
      ...this.defaultEnvironment,
      ...sanitizeEnvironment(config.env),
      ...sanitizeEnvironment(environment)
    };

    const { cmd, args: resolvedArgs } = findActualExecutable(config.command, args);

    this.logger.debug?.(`STDIO transport: command=${cmd}, args=${JSON.stringify(resolvedArgs)}`);

    const transport = new StdioClientTransport({
      command: cmd,
      args: resolvedArgs,
      env,
      stderr: 'pipe',
    });

    await this.setupTransportLifecycle(transport, config.id);
    await transport.start();
    
    return transport;
  }

  private async createSSETransport(config: ServerConfig, headers: Record<string, string>): Promise<Transport> {
    if (!config.url) {
      throw new Error('SSE transport requires URL');
    }

    const transportHeaders: HeadersInit = {
      Accept: 'text/event-stream',
      ...config.headers,
      ...headers
    };

    this.logger.debug?.(`SSE transport: url=${config.url}, headers=${JSON.stringify(transportHeaders)}`);

    const transport = new SSEClientTransport(new URL(config.url), {
      eventSourceInit: {
        fetch: (url, init) => fetch(url, { ...init, headers: transportHeaders }),
      },
      requestInit: {
        headers: transportHeaders,
      },
    });

    await this.setupTransportLifecycle(transport, config.id);
    await transport.start();
    
    return transport;
  }

  private async createStreamableHTTPTransport(config: ServerConfig, headers: Record<string, string>): Promise<Transport> {
    if (!config.url) {
      throw new Error('Streamable HTTP transport requires URL');
    }

    const transportHeaders: HeadersInit = {
      Accept: 'text/event-stream, application/json',
      ...config.headers,
      ...headers
    };

    this.logger.debug?.(`Streamable HTTP transport: url=${config.url}, headers=${JSON.stringify(transportHeaders)}`);

    const transport = new StreamableHTTPClientTransport(
      new URL(config.url),
      {
        requestInit: {
          headers: transportHeaders,
        },
      },
    );

    await this.setupTransportLifecycle(transport, config.id);
    await transport.start();
    
    return transport;
  }

  private async setupTransportLifecycle(transport: Transport, configId: string): Promise<void> {
    // Set up connection timeout
    const timeoutId = setTimeout(() => {
      this.logger.warn(`Connection timeout for ${configId} after ${this.defaultTimeout}ms`);
      transport.close().catch(err => {
        this.logger.error(`Error closing timed out transport for ${configId}:`, err);
      });
    }, this.defaultTimeout);

    // Store original handlers
    const originalOnClose = transport.onclose;
    const originalOnError = transport.onerror;

    // Clear timeout on successful connection or error
    transport.onclose = () => {
      clearTimeout(timeoutId);
      this.logger.debug?.(`Transport closed for ${configId}`);
      if (originalOnClose) {
        originalOnClose.call(transport);
      }
    };

    transport.onerror = (error) => {
      clearTimeout(timeoutId);
      this.logger.error(`Transport error for ${configId}:`, error);
      if (originalOnError) {
        originalOnError.call(transport, error);
      }
    };
  }

  /**
   * Create a transport from Express request query parameters (for backward compatibility)
   */
  async createTransportFromQuery(query: Record<string, any>, headers: Record<string, string> = {}): Promise<Transport> {
    const serverConfig: ServerConfig = {
      id: query.id || `query-${Date.now()}`,
      type: query.transportType as 'stdio' | 'sse' | 'streamable-http',
      name: query.name || `${query.transportType}-server`,
    };

    if (query.transportType === 'stdio') {
      serverConfig.command = query.command as string;
      serverConfig.args = query.args ? shellParseArgs(query.args as string) as string[] : [];
      serverConfig.env = query.env ? JSON.parse(query.env as string) : {};
    } else if (query.transportType === 'sse' || query.transportType === 'streamable-http') {
      serverConfig.url = query.url as string;
    }

    return this.createTransport({ serverConfig, headers });
  }
}