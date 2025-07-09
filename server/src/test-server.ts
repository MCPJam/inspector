#!/usr/bin/env node

import { TestServer } from './testing/TestServer.js';
import { MCPProxyService } from './shared/MCPProxyService.js';
import { DatabaseManager } from './database/DatabaseManager.js';
import { ConsoleLogger } from './shared/utils.js';
import { getDatabaseConfig } from './database/utils.js';

async function startTestServer() {
  const logger = new ConsoleLogger();
  
  try {
    // Initialize core services
    const mcpProxyService = new MCPProxyService({ 
      logger,
      maxConnections: 100 // Higher limit for test server
    });
    
    const dbConfig = getDatabaseConfig();
    const database = new DatabaseManager(dbConfig);
    await database.initialize();
    
    // Create and start test server
    const testServer = new TestServer({
      port: process.env.TEST_PORT ? parseInt(process.env.TEST_PORT) : 3002,
      host: process.env.TEST_HOST || 'localhost',
      cors: process.env.NODE_ENV !== 'production',
      rateLimiting: true,
      database: {
        url: process.env.DATABASE_URL || 'sqlite://test.db',
        maxConnections: 10,
        timeout: 5000
      },
      logging: {
        level: (process.env.LOG_LEVEL as any) || 'info',
        format: 'json',
        outputs: ['console']
      }
    });
    
    await testServer.start(mcpProxyService, database);
    
    logger.info(`🧪 Test server started on http://${testServer.config.host}:${testServer.config.port}`);
    logger.info(`📊 Health check available at http://${testServer.config.host}:${testServer.config.port}/api/test/health`);
    
    // Graceful shutdown
    process.on('SIGINT', async () => {
      logger.info('🔄 Shutting down test server...');
      await testServer.stop();
      await database.close();
      logger.info('✅ Test server shutdown complete');
      process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
      logger.info('🔄 Received SIGTERM, shutting down test server...');
      await testServer.stop();
      await database.close();
      process.exit(0);
    });
    
  } catch (error) {
    logger.error('❌ Failed to start test server:', error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startTestServer();
}