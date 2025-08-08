# MCPJam Inspector Frontend Guidelines

## Architecture Overview

The frontend is built with modern web technologies:
- Vite + React for fast development and optimized builds
- Tailwind CSS with Radix UI for consistent, accessible components
- Zustand for lightweight, flexible state management
- AI SDK integrations for LLM support

## Core Features

1. **LLM Playground**
   - OpenAI models integration
     - Model selection interface
     - Temperature/top-p controls
     - System message configuration
     - Chat history management
   - Anthropic Claude support
     - Claude 2/3 model options
     - Context window management
     - Response streaming UI
     - Error state handling
   - Ollama model compatibility
     - Local model configuration
     - Model download interface
     - Parameter tuning
     - Resource monitoring
   - Real-time chat interface
     - Message threading
     - Code highlighting
     - Markdown rendering
     - File attachments

2. **MCP Server Testing**
   - Multiple server connections
     - Connection manager UI
     - Server health monitoring
     - Configuration persistence
     - Quick switch interface
   - Configuration management
     - Transport protocol selection
     - Authentication setup
     - Rate limit configuration
     - Timeout settings
   - Transport protocol selection
     - STDIO connection UI
     - SSE stream monitoring
     - HTTP request builder
     - WebSocket integration
   - Real-time validation
     - Schema validation UI
     - Error highlighting
     - Fix suggestions
     - Test case management

3. **Developer Tools**
   - Request/response inspector
     - JSON tree viewer
     - Headers examination
     - Timing analysis
     - Search/filter tools
   - Debug console integration
     - Log level controls
     - Filter configuration
     - Stack trace viewer
     - Console commands
   - Performance monitoring
     - Response time graphs
     - Memory usage charts
     - Network analysis
     - Bottleneck detection

## Project Structure
```
/client
  /src
    /app           # Next.js App Router
      /chat        # LLM playground pages
      /servers     # Server management
      /settings    # Configuration pages
    /components    # React components
      /chat        # Chat interface components
      /servers     # Server components
      /shared      # Common UI components
    /hooks         # Custom React hooks
      /llm         # LLM integration hooks
      /mcp         # MCP protocol hooks
      /transport   # Transport layer hooks
    /lib          # Utility functions
      /api         # API client functions
      /validation  # Schema validators
      /transform   # Data transformers
    /stores        # Zustand state
      /chat        # Chat state management
      /servers     # Server configurations
      /settings    # App settings
    /styles        # Tailwind themes
  /public         # Static assets
```

## Component Guidelines

1. **React Components**
   - Use functional components
     - React.FC typing
     - Props interface definitions
     - Children prop handling
     - Event handler types
   - Implement TypeScript types
     - Strict prop types
     - Event types
     - State interfaces
     - Utility types
   - Follow React 19 patterns
     - Use hooks pattern
     - Suspense boundaries
     - Error boundaries
     - Concurrent features
   - Maintain component isolation
     - Props drilling prevention
     - Context usage
     - Component composition
     - Render optimization

2. **State Management**
   - Zustand for global state
     - Store creation
     - Action definitions
     - Selector optimization
     - Middleware usage
   - React hooks for local state
     - useState patterns
     - useReducer implementation
     - Custom hook creation
     - Effect cleanup
   - MCP state synchronization
     - Connection state
     - Request tracking
     - Response handling
     - Error management
   - AI model state handling
     - Model selection state
     - Generation parameters
     - Stream management
     - History persistence

3. **UI/UX Design**
   - Radix UI components
     - Dialog implementation
     - Dropdown menus
     - Form controls
     - Tooltips
   - Custom Tailwind themes
     - Color schemes
     - Typography system
     - Spacing scale
     - Animation classes
   - Responsive layouts
     - Breakpoint system
     - Grid layouts
     - Flex containers
     - Container queries
   - Accessibility compliance
     - ARIA attributes
     - Keyboard navigation
     - Focus management
     - Screen reader support

## LLM Integration

1. **Model Support**
   - OpenAI API integration
     - API client setup
     - Model configuration
     - Response handling
     - Error recovery
   - Claude API implementation
     - Authentication flow
     - Request formatting
     - Stream processing
     - Rate limiting
   - Ollama local models
     - Local setup
     - Model management
     - Inference options
     - Resource control
   - Response streaming
     - Token processing
     - UI updates
     - Cancel handling
     - Error states

2. **Chat Interface**
   - Real-time messaging
     - Message components
     - Input handling
     - Stream rendering
     - History management
   - Code highlighting
     - Syntax detection
     - Theme support
     - Copy functionality
     - Line numbers
   - Message threading
     - Thread components
     - Collapse/expand
     - Navigation
     - Search
   - Context management
     - Window size tracking
     - Token counting
     - Context pruning
     - State persistence

## MCP Testing Features

1. **Server Management**
   - Multiple connections
     - Connection list UI
     - Status indicators
     - Quick actions
     - Group management
   - Transport selection
     - Protocol options
     - Configuration forms
     - Validation rules
     - Default presets
   - Authentication setup
     - OAuth configuration
     - Token management
     - Scope selection
     - Refresh handling
   - Configuration persistence
     - Local storage
     - Export/import
     - Sync options
     - Backup/restore