// server/src/testing/TestServer.ts
import express from 'express';
import cors from 'cors';
import { TestServerConfig } from './types.js';
import { HealthCheck } from './HealthCheck.js';
import { MCPProxyService } from '../shared/MCPProxyService.js';
import { DatabaseManager } from '../database/DatabaseManager.js';
import { ConsoleLogger } from '../shared/utils.js';
import { Logger } from '../shared/types.js';

export class TestServer {
  private app: express.Application;
  private server: any;
  private healthCheck: HealthCheck | null = null;
  private logger: Logger;
  public readonly config: TestServerConfig;
  
  constructor(config: TestServerConfig) {
    this.config = config;
    this.logger = new ConsoleLogger();
    this.app = express();
    this.setupMiddleware();
  }
  
  private setupMiddleware(): void {
    // CORS support
    if (this.config.cors) {
      this.app.use(cors({
        origin: true,
        credentials: true
      }));
    }
    
    // Body parsing
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));
    
    // Request logging
    this.app.use((req, res, next) => {
      this.logger.info(`${req.method} ${req.path}`, {
        ip: req.ip,
        userAgent: req.get('User-Agent')
      });
      next();
    });
  }
  
  private setupRoutes(): void {
    // Health check endpoints
    this.app.get('/api/test/health', (req, res) => {
      if (!this.healthCheck) {
        return res.status(503).json({ error: 'Health check not initialized' });
      }
      res.json(this.healthCheck.getStatus());
    });
    
    this.app.get('/api/test/status', (req, res) => {
      if (!this.healthCheck) {
        return res.status(503).json({ error: 'Health check not initialized' });
      }
      res.json(this.healthCheck.getDetailedStatus());
    });
    
    // Placeholder endpoints for future implementation
    this.app.post('/api/test/run', (req, res) => {
      res.status(501).json({
        success: false,
        error: 'Test execution not yet implemented'
      });
    });
    
    this.app.post('/api/test/run-batch', (req, res) => {
      res.status(501).json({
        success: false,
        error: 'Batch test execution not yet implemented'
      });
    });
    
    this.app.get('/api/test/results', (req, res) => {
      res.status(501).json({
        success: false,
        error: 'Test results retrieval not yet implemented'
      });
    });
    
    this.app.get('/api/test/results/:id', (req, res) => {
      res.status(501).json({
        success: false,
        error: 'Test result retrieval not yet implemented'
      });
    });
    
    this.app.get('/api/test/connections', (req, res) => {
      res.status(501).json({
        success: false,
        error: 'Connection management not yet implemented'
      });
    });
    
    // Error handling
    this.app.use((error: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
      this.logger.error('Unhandled error:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error'
      });
    });
  }
  
  async start(mcpProxyService: MCPProxyService, database: DatabaseManager): Promise<void> {
    // Initialize components
    this.healthCheck = new HealthCheck(mcpProxyService, database, this.logger);
    
    // Setup routes
    this.setupRoutes();
    
    // Start server
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.config.port, this.config.host, () => {
        this.logger.info(`🧪 Test server listening on ${this.config.host}:${this.config.port}`);
        resolve();
      });
      
      this.server.on('error', (error: any) => {
        this.logger.error('Server error:', error);
        reject(error);
      });
    });
  }
  
  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server.close(() => {
          this.logger.info('🧪 Test server stopped');
          resolve();
        });
      });
    }
  }
}