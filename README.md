<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./client/public/mcp_jam_dark.png">
  <source media="(prefers-color-scheme: light)" srcset="./client/public/mcp_jam_light.png">
  <img width="250" alt="MCPJam Inspector V1 logo" src="./client/public/mcp_jam_light.png">
</picture>

<br/>

www.mcpjam.com

[![npm version](https://img.shields.io/npm/v/@mcpjam/inspector?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@mcpjam/inspector)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg?style=for-the-badge)](https://opensource.org/licenses/Apache-2.0)
[![Discord](https://img.shields.io/badge/Discord-Join%20Server-5865F2.svg?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/JEnDtz8X6z)

</div>

MCPJam inspector is the testing and debugging platform for MCP servers & OpenAI apps. Visually inspect your server's tools, resources, prompts, and OAuth. Try your server against different models in the LLM playground.

### 🚀 Quick Start

Start up the MCPJam inspector:

```bash
npx @mcpjam/inspector@latest
```

<img alt="MCPJam Inspector Demo" src="./docs/images/mcpjam-tools-tab.png">

# Table of contents

- [Installation Guides](#installation-guides)
- [Key Features](#key-features)
  - [OpenAI Apps & MCP-UI](#openai-apps--mcp-ui)
  - [OAuth Debugger](#oauth-debugger)
  - [LLM Playground](#llm-playground)
- [Contributing](#contributing-)
- [Links](#links-)
- [Community](#community-)
- [Shoutouts](#shoutouts-)
- [License](#-license)

# Installation Guides

### Requirements

[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg?style=for-the-badge&logo=node.js)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5+-blue.svg?style=for-the-badge&logo=typescript)](https://www.typescriptlang.org/)

## Install via NPM

We recommend starting MCPJam inspector via `npx`:

```bash
npx @mcpjam/inspector@latest
```

We also have a Mac and Windows desktop app:

- [Install Mac](https://github.com/MCPJam/inspector/releases/latest/download/MCPJam.Inspector.dmg)
- [Install Windows](https://github.com/MCPJam/inspector/releases/latest/download/MCPJam-Inspector-Setup.exe)

## Docker

Run MCPJam Inspector using Docker:

```bash
# Using Docker Compose (recommended)
docker-compose up -d

# Or using Docker run
docker run -d \
  -p 6274:6274 \
  --env-file .env.production \
  -e NODE_ENV=production \
  --add-host host.docker.internal:host-gateway \
  --name mcp-inspector \
  --restart unless-stopped \
  mcpjam/mcp-inspector:latest
```

The application will be available at `http://127.0.0.1:6274`.

**Important for macOS/Windows users:**

- Access the app via `http://127.0.0.1:6274` (not `localhost`)
- When connecting to MCP servers on your host machine, use `http://host.docker.internal:PORT` instead of `http://127.0.0.1:PORT`

Example:

```bash
# Your MCP server runs on host at: http://127.0.0.1:8080/mcp
# In Docker, configure it as: http://host.docker.internal:8080/mcp
```

# Key Features

## OpenAI Apps & MCP-UI

Develop [OpenAI apps](https://developers.openai.com/apps-sdk/) or [MCP-UI](https://mcpui.dev/) apps locally. No ngrok needed. MCPJam is the only local-first OpenAI app emulator.

<img alt="MCPJam LLM playground" src="./docs/images/mcpjam-mcp-ui.png">

## OAuth Debugger

View every step of the OAuth handshake in detail, with guided explanations.

<img alt="MCPJam OAuth Flow Debugger" src="./docs/images/mcpjam-oauth-flow.png">

## LLM Playground

Try your server against any LLM model. We provide frontier models like GPT-5, Claude Sonnet, Gemini 2.5. No API key needed, it's on us.

<img alt="MCPJam LLM playground" src="./docs/images/mcpjam-llm-playground.png">

# Contributing 👨‍💻

We're grateful for you considering contributing to MCPJam. Please read our [contributing guide](CONTRIBUTING.md).

You can also reach out to the contributors that hang out in our [Discord channel](https://discord.gg/JEnDtz8X6z).

# Links 🔗

- Roadmap (TBD)
- [Website](https://www.mcpjam.com/)
- [Blog](https://www.mcpjam.com/blog)
- [Pricing](https://www.mcpjam.com/pricing)
- [Docs](https://docs.mcpjam.com/)

# Community 🌍

- [Discord](https://discord.gg/JEnDtz8X6z)
- [𝕏 (Twitter)](https://x.com/mcpjams)
- [Blog](https://www.mcpjam.com/blog)
- [LinkedIn](https://www.linkedin.com/company/mcpjam)

# Shoutouts 📣

Some of our partners and favorite frameworks:

- [Stytch](https://stytch.com) - Our favorite MCP OAuth provider
- [DooiLabs/FastApps](https://github.com/DooiLabs/FastApps) - The Python framework to build OpenAI Apps.
- [xMCP](https://xmcp.dev/) - The Typescript MCP framework. Ship on Vercel instantly.
- [Alpic](https://alpic.ai/) - Host MCP servers

---

# License 📄

This project is licensed under the **Apache License 2.0** - see the [LICENSE](LICENSE).
