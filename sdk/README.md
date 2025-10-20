# @mcpjam/sdk

The official MCPJam SDK provides utilities for building, testing, and developing MCP clients and servers. Built on top of the [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/sdk), it offers high-level abstractions and tools to accelerate MCP development.

[![npm version](https://img.shields.io/npm/v/@mcpjam/sdk?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@mcpjam/sdk)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg?style=for-the-badge)](https://opensource.org/licenses/Apache-2.0)

# Installation

```bash
npm install @mcpjam/sdk
```

# Key Features

## MCPClientManager

The primary utility in the SDK is `MCPClientManager`, a powerful client manager for connecting to and interacting with MCP servers:

- **Multi-server support** - Manage multiple MCP server connections simultaneously
- **All transports** - STDIO, HTTP/SSE, and Streamable HTTP support
- **Lifecycle management** - Automatic connection handling and cleanup
- **Tools, resources, prompts** - Full MCP protocol support including elicitation
- **Agent framework integration** - Built-in adapters for Vercel AI SDK and other popular libraries
- **OAuth & authentication** - Bearer token and custom header support

### Use Cases

The SDK is designed for:

- **Building AI agents** - Connect agents to MCP servers for tool access
- **Creating MCP clients** - Build custom clients with full protocol support
- **Testing MCP servers** - Write unit tests and E2E tests for your servers
- **LLM applications** - Add MCP support to chat applications and AI workflows

### Quick Start

```ts
import { MCPClientManager } from "@mcpjam/sdk";

// Initialize with server configurations
const manager = new MCPClientManager({
  // STDIO server
  filesystem: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
  },
  // HTTP/SSE server with authentication
  asana: {
    url: new URL("https://mcp.asana.com/sse"),
    requestInit: {
      headers: {
        Authorization: "Bearer YOUR_TOKEN",
      },
    },
  },
});

// List and execute tools
const tools = await manager.getTools(["filesystem"]);
const result = await manager.executeTool("filesystem", "read_file", {
  path: "/tmp/example.txt",
});

// Integrate with Vercel AI SDK
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

const response = await generateText({
  model: openai("gpt-4o-mini"),
  tools: manager.getToolsForAiSdk(),
  messages: [{ role: "user", content: "List files in /tmp" }],
});
```

## Documentation

For detailed documentation on `MCPClientManager` including:

- Connection configuration (STDIO, HTTP/SSE)
- Tool execution and resource management
- Elicitation handling
- Agent framework integrations
- API reference

See the [MCPClientManager README](./mcp-client-manager/README.md).

## Development

### Building Locally

Build the entire SDK workspace:

```bash
npm run build
```

This compiles all sub-packages including `mcp-client-manager` and generates distributable bundles.

### Development Mode

Watch for changes and rebuild automatically:

```bash
npm run dev
```

## Resources

- **💬 Discord**: [Join the MCPJam Community](https://discord.gg/JEnDtz8X6z)
- **📖 MCP Protocol**: [Model Context Protocol Documentation](https://modelcontextprotocol.io/)
- **🔧 GitHub**: [MCPJam Inspector Repository](https://github.com/MCPJam/inspector)

## Contributing

We welcome contributions! The SDK is part of the [MCPJam Inspector monorepo](https://github.com/MCPJam/inspector). Please see our [Contributing Guide](https://docs.mcpjam.com/inspector/contributing-guide) for guidelines.

## License

Apache License 2.0 - see the [LICENSE](../LICENSE) file for details.

---

**Built with ❤️ for the MCP community** • [🌐 MCPJam.com](https://mcpjam.com)
