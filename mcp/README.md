# `@mcpjam/mcp`

Remote MCP server for MCPJam, hosted on Cloudflare Workers.

This package runs as a Cloudflare Worker backed by a Durable Object and exposes
an MCP endpoint at `/mcp`. It is a sibling to `sdk/` and `cli/` but is **not**
published to npm — clients connect to it remotely via URL.

## Status

Skeleton only. Ships a single `hello_world` tool to verify end-to-end MCP
connectivity. Real tools (evals, diagnostics, etc.) will be added in later PRs
via the `registerTools(server)` seam in [`src/server.ts`](./src/server.ts).

## Scripts

```sh
npm run dev         # wrangler dev → http://localhost:8787
npm run deploy      # wrangler deploy → *.workers.dev
npm run typecheck   # tsc --noEmit
npm run cf-typegen  # regenerate worker-configuration.d.ts
```

## Quick smoke test

```sh
npm install
npm run cf-typegen
npm run dev
```

Connect any MCP client to `http://localhost:8787/mcp`, list tools, and call
`hello_world` with `{}` or `{"name": "Marcelo"}`.

## Architecture

- `src/index.ts` — Worker entrypoint; routes `/` to a landing page and `/mcp`
  to the Durable Object.
- `src/server.ts` — Defines `McpJamMcpServer` (extends `McpAgent` from the
  `agents` package) and registers tools on the underlying `McpServer` from
  `@modelcontextprotocol/sdk`.

Modeled after [MCPJam/mcpjam-learn](https://github.com/MCPJam/mcpjam-learn),
minus auth and UI assets.
