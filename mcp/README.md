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
npm run deploy:staging  # wrangler deploy --env staging → staging *.workers.dev
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

## Delivery model

`@mcpjam/mcp` is a private workspace deploy target, not a published npm package.
It is ignored by Changesets alongside `@mcpjam/soundcheck`.

The intended rollout path is:

- open/push a PR touching `mcp/**` → `pr-mcp-preview.yml` deploys a
  dedicated per-PR worker named `mcpjam-mcp-pr-<n>` at
  `https://mcpjam-mcp-pr-<n>.<subdomain>.workers.dev` and posts the URL
  as a PR comment. Each push overwrites the same worker, so the URL is
  stable for the life of the PR. The live `mcpjam-mcp-staging` worker
  is **not** touched.
- close the PR → the per-PR worker is deleted.
- push to `main` → `deploy-mcp-staging.yml` auto-deploys the live
  `mcpjam-mcp-staging` worker.
- manual production deployment remains a separate, explicit step.

PRs that touch only `mcp/**` are intentionally excluded from the Railway
inspector preview (`pr-preview.yml`'s `paths-ignore` block) — the MCP
preview URL is the one you want for those changes.

Both the staging deploy and the PR preview workflow expect these GitHub
Actions secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

If you set a GitHub environment variable named `MCP_WORKER_STAGING_URL` on the
`mcp-staging` environment, the deployment URL will also show up directly in the
GitHub Environment UI.

## Architecture

- `src/index.ts` — Worker entrypoint; routes `/` to a landing page and `/mcp`
  to the Durable Object.
- `src/server.ts` — Defines `McpJamMcpServer` (extends `McpAgent` from the
  `agents` package) and registers tools on the underlying `McpServer` from
  `@modelcontextprotocol/sdk`.

Modeled after [MCPJam/mcpjam-learn](https://github.com/MCPJam/mcpjam-learn),
minus auth and UI assets.
