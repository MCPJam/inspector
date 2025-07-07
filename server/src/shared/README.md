# MCP Proxy Service

The MCP Proxy Service is a modular, reusable system for managing Model Context Protocol (MCP) transport connections within the MCPJam Inspector server architecture.

## Overview

This service extracts and centralizes the transport management logic that was previously embedded throughout the main server file. It provides a clean, event-driven API for creating, managing, and monitoring MCP server connections.

## Architecture

### Core Components

- **MCPProxyService**: Central service class for managing transport connections
- **TransportFactory**: Factory for creating different types of MCP transports
- **Types & Utilities**: Shared interfaces and helper functions

### Transport Types Supported

- **STDIO**: Local process spawning with environment management
- **SSE**: Server-Sent Events for real-time communication
- **Streamable HTTP**: HTTP-based transport for web applications

## Key Features

### Connection Management
- Session-based transport tracking with unique identifiers
- Maximum connection limits with overflow protection
- Automatic cleanup on transport close/error
- Real-time connection status monitoring with timestamps and error counts
- Graceful connection shutdown with `closeAllConnections()`

### Event-Driven Architecture
- Emits events for connection lifecycle (connect, disconnect, error)
- Integrates seamlessly with existing event handlers
- Supports custom event listeners for monitoring

### Transport Abstraction
- Unified API regardless of underlying transport type
- Automatic header passthrough for authentication
- Environment variable management for STDIO transports
- Connection timeout and retry handling

### TransportFactory Features
- **Centralized Creation**: Single point for creating all transport types
- **Header Management**: Automatic passthrough of authentication headers
- **Environment Handling**: Smart merging of process and custom environment variables
- **Lifecycle Management**: Automatic setup of transport event handlers and timeouts
- **Error Handling**: Comprehensive error catching with detailed logging

## Usage Examples

### Basic Connection Creation
```typescript
const mcpProxyService = new MCPProxyService({
  maxConnections: 50
});

const serverConfig: ServerConfig = {
  id: 'server-123',
  type: 'stdio',
  name: 'My MCP Server',
  command: 'node',
  args: ['mcp-server.js']
};

const sessionId = await mcpProxyService.createConnection(serverConfig);
```

### Transport Factory Direct Usage
```typescript
const transportFactory = new TransportFactory({
  logger: new ConsoleLogger(),
  defaultTimeout: 10000
});

// Create STDIO transport
const stdioConfig: ServerConfig = {
  id: 'stdio-server',
  type: 'stdio',
  name: 'Local Server',
  command: 'node',
  args: ['server.js'],
  env: { DEBUG: 'true' }
};

const transport = await transportFactory.createTransport(stdioConfig);
```

### Streamable HTTP Connection
```typescript
const { webAppTransport } = await mcpProxyService.createStreamableHTTPConnection(
  serverConfig,
  requestHeaders
);

await webAppTransport.handleRequest(req, res, body);
```

### SSE Connection
```typescript
const { sessionId } = await mcpProxyService.createSSEConnection(
  serverConfig,
  response,
  requestHeaders
);
```

### Event Handling
```typescript
mcpProxyService.on('connection', (sessionId, serverConfig) => {
  console.log(`New connection: ${sessionId} for ${serverConfig.name}`);
});

mcpProxyService.on('disconnection', (sessionId) => {
  console.log(`Connection closed: ${sessionId}`);
});

mcpProxyService.on('error', (sessionId, error) => {
  console.error(`Connection error: ${sessionId}`, error);
});
```

### Connection Status Monitoring
```typescript
// Get all active connections
const activeConnections = mcpProxyService.getActiveConnections();

// Check specific connection status
const status = mcpProxyService.getConnectionStatus(sessionId);
console.log(`Status: ${status?.status}, Errors: ${status?.errorCount}`);
```

## Configuration

### ServerConfig Interface
```typescript
interface ServerConfig {
  id: string;                          // Unique identifier
  type: 'stdio' | 'sse' | 'streamable-http';
  name: string;                        // Human-readable name
  command?: string;                    // For STDIO: command to execute
  args?: string[];                     // For STDIO: command arguments
  env?: Record<string, string>;        // For STDIO: environment variables
  url?: string;                        // For SSE/HTTP: target URL
  headers?: Record<string, string>;    // Custom headers
}
```

### Service Options
```typescript
interface MCPProxyOptions {
  logger?: Logger;                     // Custom logger instance
  maxConnections?: number;             // Maximum concurrent connections
  connectionTimeout?: number;          // Connection timeout in ms
  retryAttempts?: number;              // Number of retry attempts
}
```

## Benefits

### Code Organization
- Separates transport logic from route handling
- Enables reuse across different server components
- Provides consistent error handling and logging

### Maintainability
- Centralized connection management
- Type-safe configuration and status tracking
- Comprehensive event emission for debugging

### Extensibility
- Easy to add new transport types
- Pluggable logger interface
- Event-driven architecture for custom integrations

## Integration Notes

### Backward Compatibility
The service maintains full backward compatibility with the existing UI server. All existing routes continue to work without modification while benefiting from the improved architecture.

### Server Integration
The main server has been refactored to use the MCPProxyService:
- **Route Simplification**: All transport management moved to service methods
- **Helper Functions**: Clean request processing with `createServerConfigFromRequest()` and `extractHeaders()`
- **Graceful Shutdown**: Automatic connection cleanup on server shutdown
- **Reduced Complexity**: Main server file reduced by ~200 lines while maintaining functionality

### Error Handling
- Comprehensive error catching and logging
- Automatic connection cleanup on failures
- Status tracking for debugging and monitoring

### Performance
- Efficient session-based transport lookup
- Automatic cleanup prevents memory leaks
- Connection pooling with configurable limits

## File Structure

```
server/src/shared/
├── README.md              # This documentation
├── index.ts               # Public API exports
├── types.ts               # TypeScript interfaces
├── utils.ts               # Helper functions and logger
├── TransportFactory.ts    # Transport creation logic
└── MCPProxyService.ts     # Main service class
```

## Migration Benefits

### Before Refactoring
- ~500 lines of mixed transport and route logic in main server
- Duplicate header handling across routes
- Manual transport lifecycle management
- Inline connection cleanup code

### After Refactoring
- Clean separation of concerns with shared service
- Centralized transport management
- Consistent error handling and logging
- Reusable components for future server implementations

This modular design creates a solid foundation for future enhancements while keeping the existing server functionality intact and well-organized. The extracted service can now be easily reused in other server contexts while maintaining the same reliable transport management capabilities.