import { 
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  SSEClientTransport,
} from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { findActualExecutable } from "spawn-rx";
import { parse as shellParseArgs } from "shell-quote";

import { ServerConfig, TransportFactoryOptions, Logger } from "./types.js";
import { validateServerConfig, ConsoleLogger } from "./utils.js";

const SSE_HEADERS_PASSTHROUGH = ["authorization"];
const STREAMABLE_HTTP_HEADERS_PASSTHROUGH = [
  "authorization",
  "mcp-session-id",
  "last-event-id",
];

export class TransportFactory {
  private logger: Logger;
  private defaultTimeout: number;
  private defaultEnvironment: Record<string, string>;
  
  constructor(options: TransportFactoryOptions = {}) {
    this.logger = options.logger || new ConsoleLogger();
    this.defaultTimeout = options.defaultTimeout || 10000;
    this.defaultEnvironment = {
      ...getDefaultEnvironment(),
      ...(process.env.MCP_ENV_VARS ? JSON.parse(process.env.MCP_ENV_VARS) : {}),
    };
  }
  
  async createTransport(config: ServerConfig, headers?: Record<string, string>): Promise<Transport> {
    validateServerConfig(config);
    
    this.logger.info(`Creating ${config.type} transport for ${config.name}`);
    
    try {
      switch (config.type) {
        case 'stdio':
          return await this.createStdioTransport(config);
        case 'sse':
          return await this.createSSETransport(config, headers);
        case 'streamable-http':
          return await this.createStreamableHTTPTransport(config, headers);
        default:
          throw new Error(`Unsupported transport type: ${config.type}`);
      }
    } catch (error) {
      this.logger.error(`Failed to create transport for ${config.name}:`, error);
      throw error;
    }
  }
  
  private async createStdioTransport(config: ServerConfig): Promise<Transport> {
    const command = config.command!;
    const origArgs = config.args || [];
    const queryEnv = config.env || {};
    // Filter out undefined values from process.env
    const processEnv = Object.fromEntries(
      Object.entries(process.env).filter(([_, value]) => value !== undefined)
    ) as Record<string, string>;
    const env = { ...processEnv, ...this.defaultEnvironment, ...queryEnv };

    const { cmd, args } = findActualExecutable(command, origArgs);

    this.logger.info(`🚀 Stdio transport: command=${cmd}, args=${args}`);

    const transport = new StdioClientTransport({
      command: cmd,
      args,
      env,
      stderr: "pipe",
    });

    await transport.start();
    await this.setupTransportLifecycle(transport, config.id);
    return transport;
  }
  
  private async createSSETransport(config: ServerConfig, requestHeaders?: Record<string, string>): Promise<Transport> {
    const url = config.url!;
    const headers: HeadersInit = {
      Accept: "text/event-stream",
    };

    // Add passed-through headers
    if (requestHeaders) {
      for (const key of SSE_HEADERS_PASSTHROUGH) {
        if (requestHeaders[key] !== undefined) {
          const value = requestHeaders[key];
          headers[key] = Array.isArray(value) ? value[value.length - 1] : value;
        }
      }
    }

    // Add config headers
    if (config.headers) {
      Object.assign(headers, config.headers);
    }

    const transport = new SSEClientTransport(new URL(url), {
      eventSourceInit: {
        fetch: (url, init) => fetch(url, { ...init, headers }),
      },
      requestInit: {
        headers,
      },
    });
    
    await transport.start();
    await this.setupTransportLifecycle(transport, config.id);
    return transport;
  }
  
  private async createStreamableHTTPTransport(config: ServerConfig, requestHeaders?: Record<string, string>): Promise<Transport> {
    const headers: HeadersInit = {
      Accept: "text/event-stream, application/json",
    };

    // Add passed-through headers
    if (requestHeaders) {
      for (const key of STREAMABLE_HTTP_HEADERS_PASSTHROUGH) {
        if (requestHeaders[key] !== undefined) {
          const value = requestHeaders[key];
          headers[key] = Array.isArray(value) ? value[value.length - 1] : value;
        }
      }
    }

    // Add config headers
    if (config.headers) {
      Object.assign(headers, config.headers);
    }

    const transport = new StreamableHTTPClientTransport(
      new URL(config.url!),
      {
        requestInit: {
          headers,
        },
      },
    );
    
    await transport.start();
    await this.setupTransportLifecycle(transport, config.id);
    return transport;
  }
  
  private async setupTransportLifecycle(transport: Transport, configId: string): Promise<void> {
    // Set up event handlers without aggressive timeouts
    // The original server didn't have connection timeouts, so we preserve that behavior
    
    const originalOnClose = transport.onclose;
    transport.onclose = () => {
      this.logger.info(`Transport closed for ${configId}`);
      if (originalOnClose) {
        originalOnClose();
      }
    };
    
    const originalOnError = transport.onerror;
    transport.onerror = (error) => {
      this.logger.error(`Transport error for ${configId}:`, error);
      if (originalOnError) {
        originalOnError(error);
      }
    };
  }
}