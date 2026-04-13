# @mcpjam/cli

Stateless MCP server probing, debugging, OAuth, and conformance from your terminal.

## Install

```bash
npm i -g @mcpjam/cli
```

Or run without installing:

```bash
npx -y @mcpjam/cli@latest --help
```

## Quick start

```bash
# One-shot health check
mcpjam server doctor --url https://your-server.com/mcp

# OAuth login
mcpjam oauth login --url https://your-server.com/mcp

# Exercise tools
mcpjam tools list --url https://your-server.com/mcp
```

## Documentation

Full docs at [docs.mcpjam.com/cli](https://docs.mcpjam.com/cli).
