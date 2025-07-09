#!/usr/bin/env node

import { TestServer } from './testing/TestServer.js';
import { MCPProxyService } from './shared/MCPProxyService.js';
import { DatabaseManager } from './database/DatabaseManager.js';
import { ConsoleLogger } from './shared/utils.js';
import { getDatabaseConfig } from './database/utils.js';
import { createServer } from "node:net";
import { parseArgs } from "node:util";

// Function to find an available port
const findAvailablePort = async (startPort: number): Promise<number> => {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.listen(startPort, () => {
      const port = (server.address() as any)?.port;
      server.close(() => {
        resolve(port);
      });
    });

    server.on("error", (err: any) => {
      if (err.code === "EADDRINUSE") {
        // Port is in use, try the next one
        findAvailablePort(startPort + 1)
          .then(resolve)
          .catch(reject);
      } else {
        reject(err);
      }
    });
  });
};

async function startTestServer() {
  const logger = new ConsoleLogger();
  
  // Parse command line arguments
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      port: { type: "string", short: "p", default: "3002" },
      host: { type: "string", short: "h", default: "localhost" },
      env: { type: "string", short: "e", default: "development" },
      config: { type: "string", short: "c" },
      help: { type: "boolean", default: false }
    },
    allowPositionals: true
  });

  if (values.help) {
    console.log(`
🧪 MCPJam Inspector Test Server

Usage: node test-server.js [options]

Options:
  -p, --port <port>     Port to run the test server on (default: 3002)
  -h, --host <host>     Host to bind the server to (default: localhost)
  -e, --env <env>       Environment mode (default: development)
  -c, --config <file>   Configuration file path
  --help                Show this help message

Environment Variables:
  TEST_PORT            Override the default port
  TEST_HOST            Override the default host
  NODE_ENV             Set the environment mode
  DATABASE_URL         Database connection string
  LOG_LEVEL            Logging level (debug, info, warn, error)

Examples:
  node test-server.js --port 4000 --host 0.0.0.0
  TEST_PORT=5000 node test-server.js
  NODE_ENV=production node test-server.js
    `);
    process.exit(0);
  }
  
  try {
    // Initialize core services
    const mcpProxyService = new MCPProxyService({ 
      logger,
      maxConnections: 100 // Higher limit for test server
    });
    
    const dbConfig = getDatabaseConfig();
    const database = new DatabaseManager(dbConfig);
    await database.initialize();
    
    // Determine port with fallback logic
    const preferredPort = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT) : parseInt(values.port!);
    const actualPort = await findAvailablePort(preferredPort);
    
    // Create and start test server
    const testServer = new TestServer({
      port: actualPort,
      host: process.env.TEST_HOST || values.host!,
      cors: values.env !== 'production',
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
    
    if (actualPort !== preferredPort) {
      logger.info(`⚠️  Port ${preferredPort} was in use, using available port ${actualPort} instead`);
    }
    
    logger.info(`🧪 Test server started on http://${testServer.config.host}:${testServer.config.port}`);
    logger.info(`📊 Health check available at http://${testServer.config.host}:${testServer.config.port}/api/test/health`);
    logger.info(`🔍 Status endpoint available at http://${testServer.config.host}:${testServer.config.port}/api/test/status`);
    logger.info(`🎯 Test execution endpoint available at http://${testServer.config.host}:${testServer.config.port}/api/test/run`);
    
    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info(`🔄 Received ${signal}, shutting down test server...`);
      try {
        await testServer.stop();
        await mcpProxyService.closeAllConnections();
        await database.close();
        logger.info('✅ Test server shutdown complete');
        process.exit(0);
      } catch (error) {
        logger.error('❌ Error during shutdown:', error);
        process.exit(1);
      }
    };
    
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    
    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    });
    
    process.on('uncaughtException', (error) => {
      logger.error('❌ Uncaught Exception:', error);
      process.exit(1);
    });
    
  } catch (error) {
    logger.error('❌ Failed to start test server:', error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startTestServer();
}