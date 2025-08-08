# MCPJam Inspector Development Guidelines

## Project Overview

MCPJam Inspector is a developer tool for testing and debugging Model Context Protocol (MCP) servers. Built with Electron, it combines a Vite+React frontend and Hono.js backend to provide a comprehensive development environment for MCP server implementations.

## Quick Start

```bash
# Install dependencies
npm install

# Start development
npm run dev

# Build for production
npm run build

# Start production
npm start
```

## Project Structure

```
/inspector
  /client        # Vite + React frontend
    /src         # UI components, hooks, stores
    /public      # Static assets
  /server        # Hono.js backend
    /routes      # API endpoints, MCP handlers
    /utils       # Server utilities
  /src           # Electron main process
    /ipc         # Inter-process communication
  /shared        # Common types, utilities
```

## Core Features

1. **MCP Compliance Testing**
   - Full spec validation for tools and resources
     - Tool definition validation (name, description, parameters)
     - Resource schema verification
     - Input/output format checking
     - Parameter type validation
   - OAuth 2.0 authentication testing
     - Token flow validation
     - Scope verification
     - Refresh token handling
     - Error response testing
   - Prompt and elicitation verification
     - Context window validation
     - Token limit compliance
     - Response format checking
     - Streaming response validation
   - Real-time compliance checking
     - Live validation feedback
     - Error highlighting
     - Fix suggestions
     - Compliance reports

2. **Transport Support**
   - STDIO transport protocol
     - Bidirectional streaming
     - Process management
     - Error handling
     - Buffer management
   - Server-Sent Events (SSE)
     - Event stream handling
     - Reconnection logic
     - Message parsing
     - Error recovery
   - Streamable HTTP transport
     - Chunked transfer encoding
     - Connection pooling
     - Request/response streaming
     - Timeout handling
   - Connection management
     - Auto-reconnect
     - Load balancing
     - Circuit breaking
     - Health checks

3. **LLM Integration**
   - OpenAI models support
     - GPT-3.5/4 integration
     - API key management
     - Model selection
     - Temperature control
   - Anthropic Claude integration
     - Claude 2/3 support
     - Context handling
     - Response streaming
     - Error handling
   - Ollama model compatibility
     - Local model support
     - Custom model loading
     - Inference optimization
     - Resource management
   - Response validation
     - Format verification
     - Token counting
     - Content filtering
     - Safety checks

4. **Developer Tools**
   - Comprehensive logging
     - Request/response logs
     - Error tracking
     - Performance metrics
     - Debug information
   - Request/response tracing
     - Timing analysis
     - Headers inspection
     - Payload examination
     - Transport details
   - Error reporting and analysis
     - Stack traces
     - Error categorization
     - Resolution suggestions
     - Error patterns
   - Performance monitoring
     - Response times
     - Resource usage
     - Throughput metrics
     - Bottleneck detection

## Project Structure

```
/inspector
  /client        # React + Vite frontend
    /src         # UI components, hooks, stores
    /public      # Static assets, images
  /server        # Hono.js backend
    /routes      # API endpoints, MCP handlers
    /utils       # Server utilities
  /src           # Electron main process
    /ipc         # Inter-process communication
  /shared        # Common types, utilities
```

## Development Setup

### Quick Start
```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# Start production server
npm start
```

### Docker Support
```bash
# Run latest version
docker run -p 3001:3001 mcpjam/mcp-inspector:latest

# Run in background
docker run -d -p 3001:3001 --name mcp-inspector mcpjam/mcp-inspector:latest
```

## Best Practices

1. **Code Quality**
   - Follow TypeScript best practices
     - Strict type checking
     - Interface definitions
     - Generic constraints
     - Type guards
   - Maintain consistent code style
     - ESLint configuration
     - Prettier formatting
     - Import ordering
     - Component structure
   - Write comprehensive tests
     - Unit testing
     - Integration testing
     - E2E testing
     - Performance testing
   - Document API changes
     - OpenAPI specs
     - Breaking changes
     - Migration guides
     - Version history

2. **MCP Development**
   - Follow MCP specification
     - Protocol versioning
     - Message formats
     - Error codes
     - Extensions
   - Implement proper error handling
     - Error types
     - Recovery strategies
     - Fallback mechanisms
     - Error reporting
   - Validate server responses
     - Schema validation
     - Content verification
     - Status codes
     - Headers
   - Monitor performance metrics
     - Response times
     - Resource usage
     - Error rates
     - Throughput

3. **Security**
   - Secure API key management
     - Key rotation
     - Access control
     - Encryption
     - Auditing
   - Input validation
     - Type checking
     - Sanitization
     - Size limits
     - Format validation
   - Rate limiting
     - Request quotas
     - Throttling
     - Backoff strategies
     - Burst handling
   - Error handling
     - Safe error messages
     - Log sanitization
     - Stack trace hiding
     - Security headers

4. **Documentation**
   - Keep docs up-to-date
     - API reference
     - Setup guides
     - Best practices
     - Troubleshooting
   - Include usage examples
     - Code snippets
     - Configuration samples
     - Common patterns
     - Edge cases
   - Document breaking changes
     - Version differences
     - Migration steps
     - Deprecation notices
     - Compatibility notes
   - Maintain changelog
     - Version history
     - Feature additions
     - Bug fixes
     - Performance improvements