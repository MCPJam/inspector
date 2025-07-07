import { EventEmitter } from 'events';
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { TransportFactory } from './TransportFactory.js';
import { ServerConfig, MCPProxyOptions, ConnectionStatus } from './types.js';
import { generateSessionId, ConsoleLogger } from './utils.js';
import mcpProxy from '../mcpProxy.js';

export class MCPProxyService extends EventEmitter {
  private webAppTransports = new Map<string, Transport>();
  private backingServerTransports = new Map<string, Transport>();
  private connectionStatus = new Map<string, ConnectionStatus>();
  private transportFactory: TransportFactory;
  private logger: ConsoleLogger;
  private maxConnections: number;
  
  constructor(options: MCPProxyOptions = {}) {
    super();
    this.logger = (options.logger as ConsoleLogger) || new ConsoleLogger();
    this.maxConnections = options.maxConnections || 10;
    this.transportFactory = new TransportFactory({ logger: this.logger });
  }
  
  async createConnection(serverConfig: ServerConfig, headers?: Record<string, string>): Promise<string> {
    if (this.backingServerTransports.size >= this.maxConnections) {
      throw new Error(`Maximum connections reached (${this.maxConnections})`);
    }
    
    const sessionId = generateSessionId();
    
    try {
      this.logger.info(`Creating connection ${sessionId} for ${serverConfig.name}`);
      
      // Update status to connecting
      this.connectionStatus.set(sessionId, {
        id: sessionId,
        status: 'connecting',
        lastActivity: new Date(),
        errorCount: 0
      });
      
      // Create transport
      const transport = await this.transportFactory.createTransport(serverConfig, headers);
      
      // Store transport
      this.backingServerTransports.set(sessionId, transport);
      
      // Set up transport event handlers
      this.setupTransportEvents(sessionId, transport);
      
      // Update status to connected
      this.updateConnectionStatus(sessionId, 'connected');
      
      this.emit('connection', sessionId, serverConfig);
      
      return sessionId;
    } catch (error) {
      this.updateConnectionStatus(sessionId, 'error');
      this.logger.error(`Failed to create connection ${sessionId}:`, error);
      throw error;
    }
  }
  
  async sendMessage(sessionId: string, message: any): Promise<any> {
    const transport = this.backingServerTransports.get(sessionId);
    if (!transport) {
      throw new Error(`No transport found for session: ${sessionId}`);
    }
    
    try {
      this.updateConnectionStatus(sessionId, 'connected');
      // Use send method instead of request as Transport interface doesn't have request
      await transport.send(message);
      return; // Return void as send doesn't return response
    } catch (error) {
      this.incrementErrorCount(sessionId);
      this.logger.error(`Message failed for session ${sessionId}:`, error);
      throw error;
    }
  }
  
  async closeConnection(sessionId: string): Promise<void> {
    const transport = this.backingServerTransports.get(sessionId);
    if (transport) {
      try {
        await transport.close();
      } catch (error) {
        this.logger.error(`Error closing connection ${sessionId}:`, error);
      }
      
      this.backingServerTransports.delete(sessionId);
      this.webAppTransports.delete(sessionId);
      this.connectionStatus.delete(sessionId);
      
      this.emit('disconnection', sessionId);
    }
  }
  
  getActiveConnections(): string[] {
    return Array.from(this.backingServerTransports.keys());
  }
  
  getConnectionStatus(sessionId: string): ConnectionStatus | undefined {
    return this.connectionStatus.get(sessionId);
  }
  
  getTransport(sessionId: string): Transport | undefined {
    return this.backingServerTransports.get(sessionId);
  }
  
  setWebAppTransport(sessionId: string, transport: Transport): void {
    this.webAppTransports.set(sessionId, transport);
  }
  
  getWebAppTransport(sessionId: string): Transport | undefined {
    return this.webAppTransports.get(sessionId);
  }
  
  async closeAllConnections(): Promise<void> {
    const closePromises = Array.from(this.backingServerTransports.keys())
      .map(sessionId => this.closeConnection(sessionId));
    
    await Promise.all(closePromises);
  }
  
  // Helper method to create and setup streamable HTTP connection
  async createStreamableHTTPConnection(serverConfig: ServerConfig, headers?: Record<string, string>): Promise<{
    sessionId: string;
    webAppTransport: StreamableHTTPServerTransport;
    backingTransport: Transport;
  }> {
    const sessionId = await this.createConnection(serverConfig, headers);
    const backingTransport = this.getTransport(sessionId)!;
    
    const webAppTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: generateSessionId, // Use the generateSessionId function instead of returning the same sessionId
      onsessioninitialized: (newSessionId) => {
        console.log(`✨ Created streamable web app transport ${newSessionId}`);
        this.setWebAppTransport(newSessionId, webAppTransport);
        
        // Set up the proxy connection
        mcpProxy({
          transportToClient: webAppTransport,
          transportToServer: backingTransport,
        });

        webAppTransport.onclose = () => {
          console.log(`🧹 Cleaning up transports for session ${newSessionId}`);
          this.closeConnection(newSessionId);
        };
      },
    });
    
    await webAppTransport.start();
    
    return {
      sessionId,
      webAppTransport,
      backingTransport
    };
  }
  
  // Helper method to create and setup SSE connection
  async createSSEConnection(serverConfig: ServerConfig, res: any, headers?: Record<string, string>): Promise<{
    sessionId: string;
    webAppTransport: SSEServerTransport;
    backingTransport: Transport;
  }> {
    const sessionId = await this.createConnection(serverConfig, headers);
    const backingTransport = this.getTransport(sessionId)!;
    
    const webAppTransport = new SSEServerTransport("/message", res);
    const webAppSessionId = webAppTransport.sessionId;
    this.setWebAppTransport(webAppSessionId, webAppTransport);
    
    // Set up cleanup
    webAppTransport.onclose = () => {
      console.log(`🧹 Cleaning up transports for session ${webAppSessionId}`);
      this.closeConnection(sessionId);
    };
    
    await webAppTransport.start();
    
    // Handle stderr for stdio transports
    if (backingTransport instanceof StdioClientTransport) {
      backingTransport.stderr!.on("data", (chunk) => {
        webAppTransport.send({
          jsonrpc: "2.0",
          method: "stderr",
          params: {
            data: chunk.toString(),
          },
        });
      });
    }
    
    // Set up the proxy connection
    mcpProxy({
      transportToClient: webAppTransport,
      transportToServer: backingTransport,
    });
    
    return {
      sessionId: webAppSessionId,
      webAppTransport,
      backingTransport
    };
  }
  
  private setupTransportEvents(sessionId: string, transport: Transport): void {
    const originalOnClose = transport.onclose;
    transport.onclose = () => {
      this.logger.info(`Transport closed for session ${sessionId}`);
      this.updateConnectionStatus(sessionId, 'disconnected');
      this.emit('disconnection', sessionId);
      if (originalOnClose) {
        originalOnClose();
      }
    };
    
    const originalOnError = transport.onerror;
    transport.onerror = (error) => {
      this.logger.error(`Transport error for session ${sessionId}:`, error);
      this.updateConnectionStatus(sessionId, 'error');
      this.incrementErrorCount(sessionId);
      this.emit('error', sessionId, error);
      if (originalOnError) {
        originalOnError(error);
      }
    };
  }
  
  private updateConnectionStatus(sessionId: string, status: ConnectionStatus['status']): void {
    const current = this.connectionStatus.get(sessionId);
    if (current) {
      current.status = status;
      current.lastActivity = new Date();
      this.connectionStatus.set(sessionId, current);
    }
  }
  
  private incrementErrorCount(sessionId: string): void {
    const current = this.connectionStatus.get(sessionId);
    if (current) {
      current.errorCount += 1;
      this.connectionStatus.set(sessionId, current);
    }
  }
}