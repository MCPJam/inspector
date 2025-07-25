<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://github.com/MCPJam/inspector/blob/main/client/public/mcp_jam_dark.png">
  <source media="(prefers-color-scheme: light)" srcset="https://github.com/MCPJam/inspector/blob/main/client/public/mcp_jam_light.png">
  <img width="250" alt="MCPJam logo" src="https://github.com/MCPJam/inspector/blob/main/client/public/mcp_jam_light.png">
</picture>

<br/>

# MCPJam Inspector

[![npm version](https://img.shields.io/npm/v/@mcpjam/inspector?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@mcpjam/inspector)
[![npm downloads](https://img.shields.io/npm/dm/@mcpjam/inspector?style=for-the-badge&color=green)](https://www.npmjs.com/package/@mcpjam/inspector)
[![Docker Pulls](https://img.shields.io/docker/pulls/mcpjam/mcp-inspector?style=for-the-badge)](https://hub.docker.com/r/mcpjam/mcp-inspector)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg?style=for-the-badge)](https://opensource.org/licenses/Apache-2.0)
[![Node.js](https://img.shields.io/badge/Node.js-22.7.5+-green.svg?style=for-the-badge&logo=node.js)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8+-blue.svg?style=for-the-badge&logo=typescript)](https://www.typescriptlang.org/)
[![Discord](https://img.shields.io/badge/Discord-Join%20Server-5865F2.svg?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/JEnDtz8X6z)

</div>

MCPJam is a developer tool for testing and debugging Model Context Protocol (MCP) servers. It connects to any MCP server and allows you to manually test every part of your server. The project is open source and fully compliant to the MCP spec. 

Main features are: 

| Features                                               | Description                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| All transports supported                                           | This inspector supports STDIO, SSE, and Streambable HTTP. Connect to any MCP server with environment variables and full authorization support. |
| Full MCP Spec Compliance       | The inspector has full compliance to the MCP spec. Test any MCP implementation in your server, like tools, prompts, resources, elicitation, authorization, and correct schemas.                                    |
| Authorization Testing (OAuth 2.0)    | Support for Dynamic Client Registration (DCR) and the full OAuth 2.0 spec. Test your server's MCP token handling, authorization server implementation, and OAuth flow.                             |
| LLM Playground |Test your MCP server against LLMs or custom agents. Has support for OpenAI, Anthropic, and Ollama models. Tweak agents' system prompts and temperature. Everything you need for MCP testing all in one platform.                |
| Debugging tools             |  Everything is logged including all of the error messages. This helps quickly debug your MCP server implementation.                                                                                                       |
| Usability    | Save requests, multi-server connection, saved connections. CLI shortcuts to quickly spin up a testing environment.                                                                                                                                                  |

## 📋 Requirements

- **Node.js**: `^22.7.5` or higher
- **npm**: `^10.0.0` or higher (comes with Node.js)

---

## Quick Start

Get up and running in seconds with the MCPJam Inspector:

```bash
npx @mcpjam/inspector@latest
```

That's it! The inspector will launch automatically in your browser at `http://localhost:6274`.

### Running with Docker

You can also run the inspector using Docker. First, make sure you have Docker installed and running.

Pull the latest image from Docker Hub:

```bash
docker pull mcpjam/mcp-inspector:main
```

Then, run the container:

```bash
docker run --rm -p 6274:6274 -p 6277:6277 mcpjam/mcp-inspector:main
```

The inspector will be available in your browser at `http://127.0.0.1:6274`.

---

## 📸 Screenshots

<div align="center">
<img width="1511" alt="MCPJam Inspector Interface" src="ideation/public/mcpjam_current.png" />
</div>

---



## 🎯 Usage Examples

### Basic Usage

```bash
# Launch inspector with default settings
npx @mcpjam/inspector
```

### Connect to Local Server

```bash
# Connect to a server built at build/index.js
npx @mcpjam/inspector node build/index.js
```

### Connect with Arguments

```bash
# Pass custom arguments to your server
npx @mcpjam/inspector node server.js --port 3000 --debug
```

### Using Configuration File

```bash
# Load servers from a config file
npx @mcpjam/inspector --config ./my-config.json
```

### Example Configuration File

```json
{
  "mcpServers": {
    "my-awesome-server": {
      "command": "node",
      "args": ["build/index.js"],
      "env": {
        "API_KEY": "your-api-key",
        "DEBUG": "true"
      }
    },
    "python-server": {
      "command": "python",
      "args": ["-m", "my_mcp_server"],
      "env": {
        "PYTHONPATH": "./src"
      }
    }
  }
}
```

---

## 🏗️ Architecture

The MCPJam Inspector is built as a modern monorepo with three main components:

```
📦 @mcpjam/inspector
├── 🖥️  client/     # React + TypeScript frontend
├── 🔧  server/     # Express.js backend with WebSocket support
└── 🚀  cli/        # Command-line interface
```

### Tech Stack

- **Frontend**: React 18, TypeScript, Tailwind CSS, Radix UI
- **Backend**: Express.js, WebSocket (ws), CORS support
- **CLI**: Node.js with shell integration
- **Build Tools**: Vite, TSC, Concurrently

---

## 🛠️ Development

### Local Development Setup

```bash
# Clone the repository
git clone https://github.com/mcpjam/inspector.git
cd inspector

# Install dependencies
npm install

# Start development servers
npm run dev
```

### Build for Production

```bash
# Build all components
npm run build

# Test the build
npm run start
```

### Scripts for development

We put together these commands to help you build locally:
| Script | Description |
| ---------------------- | ------------------------------------------- |
| `npm run dev` | Start development servers (client + server) |
| `npm run build` | Build all components for production |
| `npm run test` | Run test suite |
| `npm run prettier-fix` | Format code with Prettier |
| `npm run clean` | Clean all build artifacts and reinstall |

---

## 🤝 Contributing

We welcome contributions! We thought the original inspector repository moved too slowly, so we wanted to build this project ourselves. Please read our [CONTRIBUTING.md](/CONTRIBUTING.md) for more details. 

1. **Clone** the repository
2. **Create** a feature branch (`git checkout -b feature/amazing-feature`)
3. **Commit** your changes (`git commit -m 'Add amazing feature'`)
4. **Push** to the branch (`git push origin feature/amazing-feature`)
5. **Open** a Pull Request

## 🗺️ Our Roadmap

The community is working on MCPJam v1.0.0. We are on a mission to make MCPJam a production grade project. If you're interested, please read the [design proposal](/ideation/PRODUCT_SPEC.md). We're collaborating on this on [Discord](https://discord.gg/JEnDtz8X6z)! 

## 📚 Resources

- **🌐 Website**: [mcpjam.com](https://mcpjam.com)
- **📖 Documentation**: [MCP Protocol Docs](https://modelcontextprotocol.io/)
- **🐛 Issues**: [GitHub Issues](https://github.com/mcpjam/inspector/issues)
- **💬 Discussions**: [GitHub Discussions](https://github.com/mcpjam/inspector/discussions)

---

## 📄 License

This project is licensed under the **Apache License 2.0** - see the [LICENSE](LICENSE) file for details.

---

<div align="center">

**Made with ❤️ by the [MCPJam](https://mcpjam.com) team**

</div>
