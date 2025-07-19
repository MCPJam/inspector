# MCP Inspector v1.0.0 (Hack)

[![Discord](https://img.shields.io/badge/Discord-Join%20Server-5865F2.svg?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/JEnDtz8X6z)

A modern, enterprise-grade Model Context Protocol (MCP) development tool built with Next.js and Mastra. This is the v1.0.0 implementation of the MCPJam Inspector, designed to provide developers with a comprehensive testing and debugging environment for MCP servers.

## What is MCP Inspector?

MCP Inspector is a developer tool that allows you to connect to, test, and debug Model Context Protocol (MCP) servers. It provides an intuitive web interface for interacting with MCP tools, resources, prompts, and testing the complete OAuth flow for remote MCP servers.

### Key Features

- **Multi-Protocol Support**: Connect to MCP servers via STDIO, SSE, and Streamable HTTP
- **OAuth Integration**: Full OAuth 2.0 flow with PKCE for secure remote connections
- **Real-time Testing**: Interactive tool execution, resource browsing, and prompt testing
- **LLM Playground**: Test MCP servers with various AI models (Anthropic, OpenAI, Ollama)
- **Multiple Connections**: Connect and manage multiple MCP servers simultaneously
- **Persistent State**: Connections and configurations are saved locally
- **Enterprise-Ready**: Built with TypeScript, proper error handling, and comprehensive logging

## How It Works

MCP Inspector acts as an MCP client that connects to your MCP servers and provides a web interface for testing and debugging. The architecture includes:

1. **Frontend (Next.js)**: React-based UI with TypeScript for type safety
2. **API Layer**: Next.js API routes that handle MCP communications
3. **MCP Integration**: Uses Mastra's MCP client for protocol compliance
4. **OAuth Flow**: Complete OAuth 2.0 implementation with dynamic client registration

### Supported MCP Capabilities

- ✅ **Tools**: Execute MCP tools with parameter validation and error handling
- ✅ **Resources**: Browse and read MCP server resources
- ✅ **Prompts**: Display and test MCP server prompts
- ✅ **OAuth**: Complete OAuth 2.0 flow with PKCE and token refresh
- ✅ **Multiple Transports**: STDIO, SSE, and Streamable HTTP support
- 🚧 **Sampling**: LLM sampling (playground integration)
- 🚧 **Roots**: Client root exposure (planned)
- 🚧 **Elicitation**: Interactive tool elicitation (planned)

## Project Structure

```
src/
├── app/
│   ├── api/                    # Next.js API routes
│   │   ├── mcp/               # MCP protocol endpoints
│   │   │   ├── tools/         # Tool listing and execution
│   │   │   ├── resources/     # Resource operations
│   │   │   ├── prompts/       # Prompt operations
│   │   │   └── test-connection/ # Connection testing
│   │   └── oauth/             # OAuth flow endpoints
│   │       ├── discover/      # OAuth server discovery
│   │       ├── register/      # Dynamic client registration
│   │       └── token/         # Token exchange
│   ├── oauth/callback/        # OAuth callback handler
│   ├── layout.tsx             # Root layout component
│   └── page.tsx               # Main application page
├── components/                 # React components
│   ├── ServerConnection.tsx   # Server connection management
│   ├── ToolsTab.tsx          # Tools testing interface
│   ├── ResourcesTab.tsx      # Resources browser
│   ├── PromptsTab.tsx        # Prompts interface
│   ├── ChatTab.tsx           # LLM playground
│   └── ui/                   # Shared UI components
├── hooks/
│   └── useAppState.ts        # Application state management
├── lib/                      # Utility libraries
│   ├── types.ts              # TypeScript definitions
│   ├── mcp-utils.ts          # MCP client utilities
│   └── oauth-*.ts            # OAuth implementation
└── globals.css               # Global styles
```

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn
- A Model Context Protocol (MCP) server to test

### Installation

1. **Clone and setup the project:**

   ```bash
   cd v1-0-0
   npm install
   ```

2. **Start the development server:**

   ```bash
   npm run dev
   ```

3. **Open your browser:**
   Navigate to [http://localhost:3000](http://localhost:3000)

### Quick Start Example

1. **Connect to a local MCP server:**
   - Go to the "Servers" tab
   - Select "STDIO" connection type
   - Enter command: `npx @modelcontextprotocol/server-everything`
   - Click "Connect"

2. **Test the connection:**
   - Navigate to the "Tools" tab
   - Try executing available tools
   - Check the "Resources" tab for available resources

3. **Connect to a remote server with OAuth:**
   - Select "HTTP" connection type
   - Enter your server URL
   - Enable OAuth and set scopes
   - Follow the OAuth flow

## Technology Stack

### Core Technologies

- **[Next.js 15](https://nextjs.org/)**: React framework with App Router
- **[React 19](https://react.dev/)**: UI library with modern hooks
- **[TypeScript](https://www.typescriptlang.org/)**: Type-safe development
- **[Tailwind CSS](https://tailwindcss.com/)**: Utility-first CSS framework

### MCP Integration

- **[@mastra/mcp](https://mastra.ai/)**: MCP client implementation
- **[@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/sdk)**: Official MCP SDK types

### UI Components

- **[Lucide React](https://lucide.dev/)**: Icon library
- **Custom UI Components**: Based on modern design patterns
- **Responsive Design**: Mobile-friendly interface

### Development Tools

- **ESLint**: Code linting and formatting
- **PostCSS**: CSS processing
- **Zod**: Runtime type validation

## Development

### Available Scripts

```bash
# Development
npm run dev          # Start development server with Turbopack
npm run build        # Build for production
npm run start        # Start production server
npm run lint         # Run ESLint

# Type checking (if configured)
npm run type-check   # Run TypeScript compiler checks
```

### Development Workflow

1. **Start the dev server**: `npm run dev`
2. **Make your changes**: Edit files in `src/`
3. **Test changes**: Use the web interface at localhost:3000
4. **Format code**: Run `npm run lint` before committing
5. **Build**: Test production build with `npm run build`

### Adding New MCP Capabilities

1. **Add API routes**: Create new endpoints in `src/app/api/mcp/`
2. **Update types**: Add TypeScript definitions in `src/lib/types.ts`
3. **Create UI components**: Add React components in `src/components/`
4. **Update state management**: Modify `src/hooks/useAppState.ts`

### Environment Variables

Create a `.env.local` file for environment-specific configuration:

```env
# Optional: Configure OAuth settings
OAUTH_CLIENT_NAME="MCP Inspector Dev"
OAUTH_REDIRECT_URI="http://localhost:3000/oauth/callback"

# Optional: Configure timeouts
MCP_CONNECTION_TIMEOUT=30000
```

## Configuration

### Server Configuration

Servers can be configured through the UI or by loading a configuration file. The configuration supports:

```typescript
{
  name: string;           // Server display name
  type: "stdio" | "http"; // Connection type

  // STDIO servers
  command?: string;       // Command to execute
  args?: string[];        // Command arguments
  env?: Record<string, string>; // Environment variables

  // HTTP servers
  url?: string;          // Server URL
  headers?: Record<string, string>; // Custom headers
  useOAuth?: boolean;    // Enable OAuth flow
  oauthScopes?: string[]; // OAuth scopes
}
```

### OAuth Configuration

OAuth servers must support:

- OAuth 2.0 Authorization Code flow with PKCE
- Dynamic Client Registration (RFC 7591)
- Token refresh capabilities

## Contributing

We welcome contributions to MCP Inspector! Here's how to get started:

### Setting Up for Development

1. **Fork the repository**
2. **Clone your fork:**
   ```bash
   git clone https://github.com/your-username/inspector.git
   cd inspector/v1-0-0
   ```
3. **Install dependencies:**
   ```bash
   npm install
   ```
4. **Start development:**
   ```bash
   npm run dev
   ```

### Contribution Guidelines

- **Code Style**: Follow the existing TypeScript and React patterns
- **Testing**: Test your changes with multiple MCP servers
- **Documentation**: Update README.md if adding new features
- **Types**: Maintain strong TypeScript typing
- **UI**: Follow the existing design patterns and accessibility guidelines

### Areas for Contribution

- **Protocol Compliance**: Help implement missing MCP capabilities
- **UI/UX Improvements**: Enhance the user interface and experience
- **Testing**: Add automated tests for better reliability
- **Documentation**: Improve guides and API documentation
- **Performance**: Optimize connection handling and UI performance
- **Accessibility**: Improve accessibility features

### Reporting Issues

Please report bugs and feature requests through [GitHub Issues](https://github.com/MCPJam/inspector/issues).

### Community

Join our community:

- **Discord**: [MCPJam Discord Server](https://discord.gg/JEnDtz8X6z)
- **GitHub**: [MCPJam Inspector Repository](https://github.com/MCPJam/inspector)
- **Website**: [mcpjam.com](https://www.mcpjam.com/)

## Roadmap

### v1.0.0 Goals

- ✅ **Mastra Integration**: Migrate to industry-standard MCP client
- ✅ **OAuth Flow**: Complete OAuth 2.0 implementation with PKCE
- ✅ **UI Overhaul**: Modern, enterprise-grade interface
- 🚧 **Full Spec Compliance**: Implement all MCP capabilities
- 🚧 **CLI Shortcuts**: Direct server connection from command line
- 🚧 **Testing Framework**: Automated MCP server testing

### Future Releases

- **v1.1**: CLI mode and automation features
- **v1.2**: Advanced debugging and logging
- **v1.3**: Plugin system for extensibility
- **v2.0**: Multi-project workspace support

## License

This project is open source. See the LICENSE file for details.

## Acknowledgments

- **MCP Community**: For feedback and contributions
- **Anthropic**: For the Model Context Protocol specification
- **Mastra Team**: For the excellent MCP client implementation
- **Contributors**: Everyone who has helped improve this project

---

**Built with ❤️ by the MCPJam community**

For more information, visit [mcpjam.com](https://www.mcpjam.com/) or join our [Discord](https://discord.gg/JEnDtz8X6z).
