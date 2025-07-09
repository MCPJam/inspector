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
    
    // Test execution endpoints
    this.app.post('/api/test/run', async (req, res) => {
      try {
        const { testCase } = req.body;
        
        if (!testCase || !testCase.id || !testCase.prompt || !testCase.serverConfigs) {
          return res.status(400).json({
            success: false,
            error: 'Invalid test case format. Required fields: id, prompt, serverConfigs'
          });
        }
        
        this.logger.info(`🧪 Starting test execution for: ${testCase.name || testCase.id}`);
        
        // Mock test execution for now - will be replaced with actual implementation
        const startTime = Date.now();
        
        // Simulate test execution
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const result = {
          id: `result-${Date.now()}`,
          testCase: testCase,
          toolCalls: [],
          duration: Date.now() - startTime,
          success: true,
          timestamp: new Date().toISOString(),
          metadata: {
            executionMode: 'single',
            server: 'test-server'
          }
        };
        
        this.logger.info(`✅ Test execution completed for: ${testCase.name || testCase.id}`);
        
        res.json({
          success: true,
          result: result
        });
        
      } catch (error) {
        this.logger.error('❌ Test execution failed:', error);
        res.status(500).json({
          success: false,
          error: 'Test execution failed',
          details: error instanceof Error ? error.message : String(error)
        });
      }
    });
    
    this.app.post('/api/test/run-batch', async (req, res) => {
      try {
        const { testCases } = req.body;
        
        if (!Array.isArray(testCases) || testCases.length === 0) {
          return res.status(400).json({
            success: false,
            error: 'Invalid request format. Expected array of test cases'
          });
        }
        
        this.logger.info(`🧪 Starting batch test execution for ${testCases.length} tests`);
        
        const results = [];
        const startTime = Date.now();
        
        // Process each test case
        for (const testCase of testCases) {
          if (!testCase.id || !testCase.prompt || !testCase.serverConfigs) {
            results.push({
              id: `result-${Date.now()}`,
              testCase: testCase,
              toolCalls: [],
              duration: 0,
              success: false,
              error: 'Invalid test case format',
              timestamp: new Date().toISOString()
            });
            continue;
          }
          
          const testStartTime = Date.now();
          
          // Simulate test execution
          await new Promise(resolve => setTimeout(resolve, 500));
          
          results.push({
            id: `result-${Date.now()}`,
            testCase: testCase,
            toolCalls: [],
            duration: Date.now() - testStartTime,
            success: true,
            timestamp: new Date().toISOString(),
            metadata: {
              executionMode: 'batch',
              server: 'test-server'
            }
          });
        }
        
        const totalDuration = Date.now() - startTime;
        const successCount = results.filter(r => r.success).length;
        
        this.logger.info(`✅ Batch test execution completed: ${successCount}/${testCases.length} passed`);
        
        res.json({
          success: true,
          results: results,
          summary: {
            total: testCases.length,
            passed: successCount,
            failed: testCases.length - successCount,
            duration: totalDuration
          }
        });
        
      } catch (error) {
        this.logger.error('❌ Batch test execution failed:', error);
        res.status(500).json({
          success: false,
          error: 'Batch test execution failed',
          details: error instanceof Error ? error.message : String(error)
        });
      }
    });
    
    this.app.get('/api/test/results', (req, res) => {
      try {
        const { limit = 50, offset = 0, testCaseId } = req.query;
        
        // Mock results for now - will be replaced with database queries
        const mockResults = [
          {
            id: 'result-1',
            testCase: { id: 'test-1', name: 'Sample Test', prompt: 'Test prompt' },
            toolCalls: [],
            duration: 1250,
            success: true,
            timestamp: new Date().toISOString()
          }
        ];
        
        res.json({
          success: true,
          results: mockResults,
          pagination: {
            limit: parseInt(limit as string),
            offset: parseInt(offset as string),
            total: mockResults.length
          }
        });
        
      } catch (error) {
        this.logger.error('❌ Failed to retrieve test results:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to retrieve test results',
          details: error instanceof Error ? error.message : String(error)
        });
      }
    });
    
    this.app.get('/api/test/results/:id', (req, res) => {
      try {
        const { id } = req.params;
        
        // Mock result for now - will be replaced with database query
        const mockResult = {
          id: id,
          testCase: { id: 'test-1', name: 'Sample Test', prompt: 'Test prompt' },
          toolCalls: [],
          duration: 1250,
          success: true,
          timestamp: new Date().toISOString(),
          metadata: {
            executionMode: 'single',
            server: 'test-server'
          }
        };
        
        res.json({
          success: true,
          result: mockResult
        });
        
      } catch (error) {
        this.logger.error('❌ Failed to retrieve test result:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to retrieve test result',
          details: error instanceof Error ? error.message : String(error)
        });
      }
    });
    
    this.app.get('/api/test/connections', (req, res) => {
      try {
        // Mock connection info for now
        const mockConnections = [
          {
            id: 'conn-1',
            name: 'Test Server',
            type: 'stdio',
            status: 'connected',
            lastActivity: new Date().toISOString()
          }
        ];
        
        res.json({
          success: true,
          connections: mockConnections,
          summary: {
            total: mockConnections.length,
            active: mockConnections.filter(c => c.status === 'connected').length,
            inactive: mockConnections.filter(c => c.status !== 'connected').length
          }
        });
        
      } catch (error) {
        this.logger.error('❌ Failed to retrieve connections:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to retrieve connections',
          details: error instanceof Error ? error.message : String(error)
        });
      }
    });
    
    // Test case management endpoints
    this.app.get('/api/test/cases', (req, res) => {
      try {
        const { limit = 50, offset = 0 } = req.query;
        
        // Mock test cases for now
        const mockTestCases = [
          {
            id: 'test-1',
            name: 'Sample Test Case',
            prompt: 'Test the weather tool functionality',
            expectedTools: ['get_weather'],
            serverConfigs: [{ id: 'server-1', name: 'Weather Server' }],
            timeout: 30000,
            metadata: { category: 'weather' }
          }
        ];
        
        res.json({
          success: true,
          testCases: mockTestCases,
          pagination: {
            limit: parseInt(limit as string),
            offset: parseInt(offset as string),
            total: mockTestCases.length
          }
        });
        
      } catch (error) {
        this.logger.error('❌ Failed to retrieve test cases:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to retrieve test cases',
          details: error instanceof Error ? error.message : String(error)
        });
      }
    });
    
    this.app.post('/api/test/cases', async (req, res) => {
      try {
        const testCase = req.body;
        
        if (!testCase.name || !testCase.prompt || !testCase.serverConfigs) {
          return res.status(400).json({
            success: false,
            error: 'Invalid test case format. Required fields: name, prompt, serverConfigs'
          });
        }
        
        // Generate ID if not provided
        if (!testCase.id) {
          testCase.id = `test-${Date.now()}`;
        }
        
        this.logger.info(`💾 Creating test case: ${testCase.name}`);
        
        // Mock save operation
        const savedTestCase = {
          ...testCase,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        
        res.status(201).json({
          success: true,
          testCase: savedTestCase
        });
        
      } catch (error) {
        this.logger.error('❌ Failed to create test case:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to create test case',
          details: error instanceof Error ? error.message : String(error)
        });
      }
    });
    
    this.app.get('/api/test/cases/:id', (req, res) => {
      try {
        const { id } = req.params;
        
        // Mock test case
        const mockTestCase = {
          id: id,
          name: 'Sample Test Case',
          prompt: 'Test the weather tool functionality',
          expectedTools: ['get_weather'],
          serverConfigs: [{ id: 'server-1', name: 'Weather Server' }],
          timeout: 30000,
          metadata: { category: 'weather' },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        
        res.json({
          success: true,
          testCase: mockTestCase
        });
        
      } catch (error) {
        this.logger.error('❌ Failed to retrieve test case:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to retrieve test case',
          details: error instanceof Error ? error.message : String(error)
        });
      }
    });
    
    // Statistics endpoint
    this.app.get('/api/test/stats', (_req, res) => {
      try {
        const stats = {
          testCases: {
            total: 1,
            active: 1,
            inactive: 0
          },
          testResults: {
            total: 1,
            passed: 1,
            failed: 0,
            recentRuns: 1
          },
          connections: {
            total: 1,
            active: 1,
            inactive: 0
          },
          performance: {
            averageTestDuration: 1250,
            successRate: 100,
            lastRunTime: new Date().toISOString()
          }
        };
        
        res.json({
          success: true,
          stats: stats
        });
        
      } catch (error) {
        this.logger.error('❌ Failed to retrieve statistics:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to retrieve statistics',
          details: error instanceof Error ? error.message : String(error)
        });
      }
    });
    
    // Error handling
    this.app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
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