# @mcpjam/sdk

The MCPJam SDK gathers utilities for the testing and development of MCP clients and servers

## Installation

```bash
npm install @mcpjam/sdk @modelcontextprotocol/sdk
```

## Usage

```ts
import { MCPClientManager } from "@mcpjam/sdk";
// or import specific helpers
import { MCPClientManager } from "@mcpjam/sdk/mcp-client-manager";
```

## Building locally

Run the build once to compile every package in the `sdk/` workspace:

```bash
npm run build
```

This command also builds individual sub-packages (such as `mcp-client-manager`) so they are ready to publish independently if needed.
