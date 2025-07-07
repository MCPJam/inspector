import { EventEmitter } from 'events';
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isJSONRPCRequest } from '@modelcontextprotocol/sdk/types.js';
import { TransportFactory } from './TransportFactory.js';
import { 
  ServerConfig, 
  MCPProxyOptions, 
  ConnectionStatus, 
  ProxyConnectionInfo,
  Logger,
  TransportCreationRequest 
} from './types.js';
import { generateSessionId, ConsoleLogger } from './utils.js';

export class MCPProxyService extends EventEmitter {
  private connections = new Map<string, ProxyConnectionInfo>();
  private transportFactory: TransportFactory;
  private logger: Logger;
  private maxConnections: number;
  private connectionTimeout: number;
  private retryAttempts: number;

  constructor(options: MCPProxyOptions = {}) {
    super();
    this.logger = options.logger || new ConsoleLogger('MCPProxyService');
    this.maxConnections = options.maxConnections || 50;
    this.connectionTimeout = options.connectionTimeout || 30000;
    this.retryAttempts = options.retryAttempts || 3;
    
    this.transportFactory = new TransportFactory({
      logger: this.logger,
      defaultTimeout: this.connectionTimeout,
      defaultEnvironment: options.defaultEnvironment
    });
  }

  /**
   * Create a new connection to an MCP server
   */
  async createConnection(serverConfig: ServerConfig, headers: Record<string, string> = {}): Promise<string> {
    if (this.connections.size >= this.maxConnections) {
      throw new Error(`Maximum connections reached (${this.maxConnections})`);
    }

    const sessionId = generateSessionId();
    
    this.logger.info(`Creating connection ${sessionId} for ${serverConfig.name}`);
    
    // Create connection info with initial status
    const connectionInfo: ProxyConnectionInfo = {
      sessionId,
      serverConfig,
      clientTransport: null,
      serverTransport: null,
      status: {
        id: sessionId,
        status: 'connecting',
        lastActivity: new Date(),
        errorCount: 0,
        serverConfig
      },
      createdAt: new Date()
    };

    this.connections.set(sessionId, connectionInfo);

    try {
      // Create server transport
      const serverTransport = await this.transportFactory.createTransport({
        serverConfig,
        headers
      });

      // Update connection info
      connectionInfo.serverTransport = serverTransport;
      connectionInfo.status.status = 'connected';
      connectionInfo.status.lastActivity = new Date();

      // Set up transport event handlers
      this.setupServerTransportEvents(sessionId, serverTransport);

      this.emit('connection', sessionId, serverConfig);
      
      return sessionId;
    } catch (error) {
      this.updateConnectionStatus(sessionId, 'error');
      this.logger.error(`Failed to create connection ${sessionId}:`, error);
      this.connections.delete(sessionId);
      throw error;
    }
  }

  /**
   * Connect a client transport to an existing server connection
   */
  connectClientTransport(sessionId: string, clientTransport: Transport): void {
    const connection = this.connections.get(sessionId);
    if (!connection) {
      throw new Error(`No connection found for session: ${sessionId}`);
    }

    if (!connection.serverTransport) {
      throw new Error(`Server transport not ready for session: ${sessionId}`);
    }

    connection.clientTransport = clientTransport;
    this.setupClientTransportEvents(sessionId, clientTransport);
    this.setupProxy(sessionId, clientTransport, connection.serverTransport);
    
    this.logger.info(`Client transport connected for session ${sessionId}`);
    this.updateConnectionStatus(sessionId, 'connected');
  }

  /**
   * Send a message directly to a server transport (for testing)
   */
  async sendMessage(sessionId: string, message: any): Promise<any> {
    const connection = this.connections.get(sessionId);
    if (!connection?.serverTransport) {
      throw new Error(`No server transport found for session: ${sessionId}`);
    }

    try {
      this.updateConnectionStatus(sessionId, 'connected');
      const response = await connection.serverTransport.send(message);
      return response;
    } catch (error) {
      this.incrementErrorCount(sessionId);
      this.logger.error(`Message failed for session ${sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Close a connection
   */
  async closeConnection(sessionId: string): Promise<void> {
    const connection = this.connections.get(sessionId);
    if (!connection) {
      return;
    }

    this.logger.info(`Closing connection ${sessionId}`);

    try {
      // Close transports
      if (connection.clientTransport) {
        await connection.clientTransport.close();
      }
      if (connection.serverTransport) {
        await connection.serverTransport.close();
      }
    } catch (error) {
      this.logger.error(`Error closing connection ${sessionId}:`, error);
    }

    this.connections.delete(sessionId);
    this.emit('disconnection', sessionId);
  }

  /**
   * Get all active connection IDs
   */
  getActiveConnections(): string[] {
    return Array.from(this.connections.keys());
  }

  /**
   * Get connection status
   */
  getConnectionStatus(sessionId: string): ConnectionStatus | undefined {
    return this.connections.get(sessionId)?.status;
  }

  /**
   * Get connection info
   */
  getConnectionInfo(sessionId: string): ProxyConnectionInfo | undefined {
    return this.connections.get(sessionId);
  }

  /**
   * Get all connections
   */
  getAllConnections(): ProxyConnectionInfo[] {
    return Array.from(this.connections.values());
  }

  /**
   * Close all connections
   */
  async closeAllConnections(): Promise<void> {
    const closePromises = Array.from(this.connections.keys())
      .map(sessionId => this.closeConnection(sessionId));
    
    await Promise.all(closePromises);
  }

  /**
   * Create transport from Express query (for backward compatibility)
   */
  async createTransportFromQuery(query: Record<string, any>, headers: Record<string, string> = {}): Promise<Transport> {
    return this.transportFactory.createTransportFromQuery(query, headers);
  }

  /**
   * Health check
   */
  getHealth(): { status: string; connections: number; maxConnections: number } {
    return {
      status: 'ok',
      connections: this.connections.size,
      maxConnections: this.maxConnections
    };
  }

  private setupServerTransportEvents(sessionId: string, transport: Transport): void {
    transport.onclose = () => {
      this.logger.info(`Server transport closed for session ${sessionId}`);
      this.updateConnectionStatus(sessionId, 'disconnected');
      this.emit('disconnection', sessionId);
    };

    transport.onerror = (error) => {
      this.logger.error(`Server transport error for session ${sessionId}:`, error);
      this.updateConnectionStatus(sessionId, 'error');
      this.incrementErrorCount(sessionId);
      this.emit('error', sessionId, error);
    };
  }

  private setupClientTransportEvents(sessionId: string, transport: Transport): void {
    transport.onclose = () => {
      this.logger.info(`Client transport closed for session ${sessionId}`);
      this.closeConnection(sessionId);
    };

    transport.onerror = (error) => {
      this.logger.error(`Client transport error for session ${sessionId}:`, error);
      this.incrementErrorCount(sessionId);
    };
  }

  private setupProxy(sessionId: string, clientTransport: Transport, serverTransport: Transport): void {
    let clientClosed = false;
    let serverClosed = false;

    const onClientError = (error: Error) => {
      this.logger.error(`Client transport error for session ${sessionId}:`, error);
    };

    const onServerError = (error: Error) => {
      this.logger.error(`Server transport error for session ${sessionId}:`, error);
    };

    // Forward messages from client to server
    clientTransport.onmessage = (message) => {
      if (serverClosed) return;
      
      serverTransport.send(message).catch((error) => {
        // Send error response back to client if it was a request (has id) and connection is still open
        if (isJSONRPCRequest(message) && !clientClosed) {
          const errorResponse = {
            jsonrpc: "2.0" as const,
            id: message.id,
            error: {
              code: -32001,
              message: error.message,
              data: error,
            },
          };
          clientTransport.send(errorResponse).catch(onClientError);
        }
      });
    };

    // Forward messages from server to client
    serverTransport.onmessage = (message) => {
      if (clientClosed) return;
      clientTransport.send(message).catch(onClientError);
    };

    // Handle connection closures
    clientTransport.onclose = () => {
      if (serverClosed) return;
      clientClosed = true;
      serverTransport.close().catch(onServerError);
    };

    serverTransport.onclose = () => {
      if (clientClosed) return;
      serverClosed = true;
      clientTransport.close().catch(onClientError);
    };
  }

  private updateConnectionStatus(sessionId: string, status: ConnectionStatus['status']): void {
    const connection = this.connections.get(sessionId);
    if (connection) {
      connection.status.status = status;
      connection.status.lastActivity = new Date();
    }
  }

  private incrementErrorCount(sessionId: string): void {
    const connection = this.connections.get(sessionId);
    if (connection) {
      connection.status.errorCount += 1;
    }
  }
}