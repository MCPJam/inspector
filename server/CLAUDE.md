# MCPJam Inspector Backend Guidelines

## Architecture Overview

The backend is built with modern technologies:

- Hono.js for API routing and middleware
- TypeScript for type safety
- Mastra framework (@mastra/core, @mastra/mcp) for MCP protocol implementation
- AI SDK integrations (OpenAI, Anthropic, Ollama) for LLM support

## Core Features

1. **MCP Server Testing**
   - Full spec validation
     - Tool schema validation
     - Resource definition checks
     - Parameter constraints
     - Response format validation
   - OAuth 2.0 testing
     - Token validation flow
     - Scope verification
     - Refresh mechanisms
     - Error simulation
   - Prompt verification
     - Context validation
     - Token limits
     - Format checking
     - Stream validation
   - Resource validation
     - Schema compliance
     - Type checking
     - Required fields
     - Custom validators

2. **Transport Protocols**
   - STDIO transport
     - Process spawning
     - Stream handling
     - Buffer management
     - Error recovery
   - Server-Sent Events (SSE)
     - Event streaming
     - Connection handling
     - Reconnection logic
     - Message formatting
   - Streamable HTTP
     - Chunked encoding
     - Connection pools
     - Stream management
     - Timeout handling
   - Connection management
     - Health checks
     - Load balancing
     - Circuit breakers
     - Auto-recovery

3. **LLM Integration**
   - OpenAI integration
     - API client setup
     - Model management
     - Stream processing
     - Error handling
   - Claude implementation
     - Authentication
     - Request handling
     - Response streaming
     - Rate limiting
   - Ollama support
     - Local setup
     - Model loading
     - Inference config
     - Resource mgmt
   - Response handling
     - Stream processing
     - Token counting
     - Format validation
     - Safety checks

## Project Structure

```
/server
  /routes           # API endpoints
    /mcp            # MCP protocol handlers
      /tools        # Tool validation
      /resources    # Resource handlers
      /prompts      # Prompt processing
    /llm            # LLM integrations
      /openai       # OpenAI handlers
      /claude       # Claude handlers
      /ollama       # Ollama setup
    /transport      # Transport protocols
      /stdio        # STDIO handlers
      /sse          # SSE implementation
      /http         # HTTP streaming
  /utils            # Utility functions
    /mcp-utils.ts   # MCP helpers
    /validation.ts  # Schema validation
    /transform.ts   # Data transformers
  /types            # TypeScript types
    /mcp.ts         # MCP types
    /transport.ts   # Transport types
    /llm.ts         # LLM types
  app.ts            # Hono app setup
  index.ts          # Server entry
```

## Development

### Setup

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

## MCP Implementation

1. **Protocol Handlers**
   - Tool validation
     - Schema checking
     - Parameter validation
     - Response format
     - Error handling
   - Resource management
     - CRUD operations
     - Schema validation
     - Access control
     - Caching
   - Prompt processing
     - Context handling
     - Token management
     - Format validation
     - Stream control
   - Elicitation support
     - Query handling
     - Response format
     - Validation rules
     - Error states

2. **Transport Layer**
   - STDIO protocol
     - Process control
     - Stream handling
     - Buffer mgmt
     - Error recovery
   - SSE implementation
     - Event streaming
     - Connection mgmt
     - Reconnection
     - Message format
   - HTTP streaming
     - Chunk encoding
     - Connection pools
     - Stream control
     - Timeout mgmt
   - Connection pooling
     - Pool config
     - Connection limits
     - Timeout handling
     - Error recovery

3. **OAuth Integration**
   - Authentication flows
     - Grant types
     - Token exchange
     - Scope handling
     - Error states
   - Token management
     - Storage
     - Refresh logic
     - Validation
     - Revocation
   - Scope validation
     - Permission check
     - Role mapping
     - Access control
     - Audit logs
   - Session handling
     - State management
     - Timeout config
     - Cleanup tasks
     - Security checks

## LLM Features

1. **Model Support**
   - OpenAI integration
     - API setup
     - Model config
     - Stream handling
     - Error recovery
   - Claude implementation
     - Auth flow
     - Request format
     - Response stream
     - Rate limits
   - Ollama compatibility
     - Setup process
     - Model mgmt
     - Config options
     - Resource ctrl
   - Response streaming
     - Token process
     - Format check
     - Error handle
     - Safety rules

2. **Testing**
   - MCP Testing
     - Spec compliance
     - Tool validation
     - Resource check
     - Error cases
   - Transport testing
     - Protocol verify
     - Connection test
     - Stream checks
     - Error handling
   - Integration tests
     - API endpoints
     - Auth flows
     - LLM connect
     - Error states
   - Performance tests
     - Response time
     - Throughput
     - Resource use
     - Bottlenecks
