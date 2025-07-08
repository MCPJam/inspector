import { EventEmitter } from 'events';
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { TransportFactory } from './TransportFactory.js';
import { ServerConfig, MCPProxyOptions, ConnectionStatus, Logger } from './types.js';
import { generateSessionId, ConsoleLogger } from './utils.js';
import mcpProxy from '../mcpProxy.js';

export class MCPProxyService extends EventEmitter {
  private webAppTransports = new Map<string, Transport>();
  private backingServerTransports = new Map<string, Transport>();
  private connectionStatus = new Map<string, ConnectionStatus>();
  private transportFactory: TransportFactory;
  private logger: Logger;
  private maxConnections: number;
  private connectionTimeout: number;
  private retryAttempts: number;
  
  constructor(options: MCPProxyOptions = {}) {
    super();
    this.logger = options.logger || new ConsoleLogger();
    this.maxConnections = options.maxConnections || 50;
    this.connectionTimeout = options.connectionTimeout || 30000;
    this.retryAttempts = options.retryAttempts || 3;
    this.transportFactory = new TransportFactory({ 
      logger: this.logger,
      defaultTimeout: this.connectionTimeout 
    });
  }

  async createConnection(serverConfig: ServerConfig, requestHeaders?: Record<string, string>): Promise<string> {
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
      const transport = await this.transportFactory.createTransport(serverConfig, requestHeaders);
      
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

  getActiveConnections(): string[] {
    return Array.from(this.backingServerTransports.keys());
  }
  
  getConnectionStatus(sessionId: string): ConnectionStatus | undefined {
    return this.connectionStatus.get(sessionId);
  }
  
  getAllConnectionStatuses(): ConnectionStatus[] {
    return Array.from(this.connectionStatus.values());
  }

  async sendMessage(sessionId: string, message: any): Promise<void> {
    const transport = this.backingServerTransports.get(sessionId);
    if (!transport) {
      throw new Error(`No transport found for session: ${sessionId}`);
    }
    
    try {
      this.updateConnectionStatus(sessionId, 'connected');
      await transport.send(message);
    } catch (error) {
      this.incrementErrorCount(sessionId);
      this.logger.error(`Message failed for session ${sessionId}:`, error);
      throw error;
    }
  }

  getTransport(sessionId: string): Transport | undefined {
    return this.backingServerTransports.get(sessionId);
  }

  getWebAppTransport(sessionId: string): Transport | undefined {
    return this.webAppTransports.get(sessionId);
  }

  setWebAppTransport(sessionId: string, transport: Transport): void {
    this.webAppTransports.set(sessionId, transport);
    this.logger.info(`Web app transport set for session ${sessionId}`);
  }

  removeWebAppTransport(sessionId: string): void {
    this.webAppTransports.delete(sessionId);
    this.logger.info(`Web app transport removed for session ${sessionId}`);
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
      this.logger.info(`Connection ${sessionId} closed and cleaned up`);
    }
  }

  async closeAllConnections(): Promise<void> {
    const closePromises = Array.from(this.backingServerTransports.keys())
      .map(sessionId => this.closeConnection(sessionId));
    
    await Promise.all(closePromises);
    this.logger.info(`All connections closed (${closePromises.length} total)`);
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

  private setupTransportEvents(sessionId: string, transport: Transport): void {
    // Store original handlers to preserve existing functionality
    const originalOnClose = transport.onclose;
    const originalOnError = transport.onerror;
    
    transport.onclose = () => {
      this.logger.info(`Transport closed for session ${sessionId}`);
      this.updateConnectionStatus(sessionId, 'disconnected');
      
      // Clean up the connection automatically
      this.backingServerTransports.delete(sessionId);
      this.webAppTransports.delete(sessionId);
      this.connectionStatus.delete(sessionId);
      
      this.emit('disconnection', sessionId);
      
      // Call original handler if it exists
      if (originalOnClose) {
        originalOnClose();
      }
    };
    
    transport.onerror = (error) => {
      this.logger.error(`Transport error for session ${sessionId}:`, error);
      this.updateConnectionStatus(sessionId, 'error');
      this.incrementErrorCount(sessionId);
      this.emit('error', sessionId, error);
      
      // Call original handler if it exists
      if (originalOnError) {
        originalOnError(error);
      }
    };
  }

  // Helper methods for StreamableHTTP transport handling
  async createStreamableHTTPConnection(serverConfig: ServerConfig, requestHeaders?: Record<string, string>): Promise<{sessionId: string, webAppTransport: StreamableHTTPServerTransport}> {
    const sessionId = await this.createConnection(serverConfig, requestHeaders);
    
    const webAppTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
      onsessioninitialized: (newSessionId) => {
        this.logger.info(`✨ Created streamable web app transport ${newSessionId}`);
        this.setWebAppTransport(newSessionId, webAppTransport);
        
        // Set up proxy between web app transport and backing server transport
        const backingTransport = this.getTransport(newSessionId);
        if (backingTransport) {
          mcpProxy({
            transportToClient: webAppTransport,
            transportToServer: backingTransport,
          });
        }

        // Set up cleanup handler
        webAppTransport.onclose = () => {
          this.logger.info(`🧹 Cleaning up transports for session ${newSessionId}`);
          this.closeConnection(newSessionId);
        };
      },
    });

    await webAppTransport.start();
    return { sessionId, webAppTransport };
  }

  // Helper method for SSE transport handling  
  async createSSEConnection(serverConfig: ServerConfig, res: any, requestHeaders?: Record<string, string>): Promise<{sessionId: string, webAppTransport: SSEServerTransport}> {
    const connectionId = await this.createConnection(serverConfig, requestHeaders);
    
    const webAppTransport = new SSEServerTransport("/message", res);
    const sessionId = webAppTransport.sessionId;
    this.setWebAppTransport(sessionId, webAppTransport);

    // Set up cleanup handler
    webAppTransport.onclose = () => {
      this.logger.info(`🧹 Cleaning up transports for session ${sessionId}`);
      this.closeConnection(connectionId);
    };

    await webAppTransport.start();

    // Set up proxy between web app transport and backing server transport
    const backingTransport = this.getTransport(connectionId);
    if (backingTransport) {
      mcpProxy({
        transportToClient: webAppTransport,
        transportToServer: backingTransport,
      });
    }

    return { sessionId, webAppTransport };
  }
}