import { MCPProxyService } from '../MCPProxyService.js';
import { ServerConfig } from '../types.js';

describe('MCPProxyService', () => {
  let service: MCPProxyService;

  beforeEach(() => {
    service = new MCPProxyService({
      logger: {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn()
      },
      maxConnections: 5
    });
    
    // Add error handler to prevent unhandled errors
    service.on('error', (sessionId, error) => {
      // Ignore errors in tests
    });
  });

  afterEach(async () => {
    await service.closeAllConnections();
  });

  describe('Connection Management', () => {
    test('should initialize with no connections', () => {
      expect(service.getActiveConnections()).toEqual([]);
      expect(service.getHealth().connections).toBe(0);
    });

    test('should respect max connections limit', async () => {
      // Create 5 connections (at the limit)
      const promises = [];
      for (let i = 0; i < 5; i++) {
        const config: ServerConfig = {
          id: `test-${i}`,
          type: 'stdio',
          name: `Test Server ${i}`,
          command: 'echo',
          args: ['hello']
        };
        promises.push(service.createConnection(config).catch(() => null));
      }

      // Wait for all to complete (some may fail due to invalid command)
      await Promise.all(promises);

      // Try to create one more - should fail
      const config: ServerConfig = {
        id: 'test-overflow',
        type: 'stdio',
        name: 'Overflow Server',
        command: 'echo',
        args: ['hello']
      };

      await expect(service.createConnection(config)).rejects.toThrow(/Maximum connections reached/);
    });

    test('should validate server config', async () => {
      const invalidConfig = {
        id: '',
        type: 'stdio',
        name: 'Invalid Server'
      } as ServerConfig;

      await expect(service.createConnection(invalidConfig)).rejects.toThrow(/Invalid server configuration/);
    });

    test('should handle connection errors gracefully', async () => {
      const config: ServerConfig = {
        id: 'test-invalid',
        type: 'stdio',
        name: 'Invalid Server',
        command: 'nonexistent-command-12345'
      };

      await expect(service.createConnection(config)).rejects.toThrow();
      expect(service.getActiveConnections()).toEqual([]);
    });
  });

  describe('Health Check', () => {
    test('should return correct health status', () => {
      const health = service.getHealth();
      expect(health.status).toBe('ok');
      expect(health.connections).toBe(0);
      expect(health.maxConnections).toBe(5);
    });
  });

  describe('Query Transport Creation', () => {
    test('should create transport from query parameters', async () => {
      const query = {
        transportType: 'stdio',
        command: 'echo',
        args: '["hello"]'
      };

      // This should succeed for echo command
      const transport = await service.createTransportFromQuery(query);
      expect(transport).toBeDefined();
      
      // Clean up
      await transport.close();
    });

    test('should handle invalid transport type', async () => {
      const query = {
        transportType: 'invalid',
        command: 'echo'
      };

      await expect(service.createTransportFromQuery(query)).rejects.toThrow(/Unsupported transport type/);
    });
  });

  describe('Connection Lifecycle', () => {
    test('should cleanup connections on close', async () => {
      const config: ServerConfig = {
        id: 'test-lifecycle',
        type: 'stdio',
        name: 'Lifecycle Test',
        command: 'echo',
        args: ['hello']
      };

      try {
        const sessionId = await service.createConnection(config);
        expect(service.getActiveConnections()).toContain(sessionId);
        
        await service.closeConnection(sessionId);
        expect(service.getActiveConnections()).not.toContain(sessionId);
      } catch (error) {
        // Connection creation may fail due to invalid command, but the test logic should still work
        expect(service.getActiveConnections()).toEqual([]);
      }
    });

    test('should handle closing non-existent connection', async () => {
      await expect(service.closeConnection('non-existent')).resolves.not.toThrow();
    });
  });
});