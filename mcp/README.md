# `@mcpjam/mcp`

Remote MCP server for MCPJam, hosted on Cloudflare Workers.

This package runs as a Cloudflare Worker backed by a Durable Object and exposes
an MCP endpoint at `/mcp`. It is a sibling to `sdk/` and `cli/` but is **not**
published to npm — clients connect to it remotely via URL.

## Status

Skeleton. Protected by WorkOS AuthKit and ships one `whoami` tool that proves
the bearer token reached Convex and resolved to an MCPJam user. Real tools
(evals, diagnostics, etc.) will be added in later PRs on top of this auth
foundation.

## Auth

The worker is an OAuth 2.0 protected resource. AuthKit is the authorization
server; the worker validates AuthKit-issued JWTs with `jose` against the
tenant's JWKS and exposes discovery metadata:

- `GET /.well-known/oauth-protected-resource/mcp` — path-scoped PRM; `resource`
  is the full MCP URL (e.g. `https://host/mcp`), not just the origin.
- `GET /.well-known/oauth-protected-resource` — root alias for clients that
  don't path-scope their lookup.
- `GET /.well-known/oauth-authorization-server` — compat proxy to the AuthKit
  issuer's discovery doc for older MCP clients.

Unauthenticated requests to `/mcp` get a `401` with a `WWW-Authenticate` header
pointing at the PRM URL, which MCP clients use to kick off the OAuth flow.

The verified bearer token is forwarded to Convex via `ConvexHttpClient.setAuth`
so Convex sees the same WorkOS identity the main app does. The `whoami` tool
calls `users:ensureUser` (idempotent) then `users:getCurrentUser`.

### AuthKit domains

| Target | `AUTHKIT_DOMAIN` |
| --- | --- |
| Production (`wrangler deploy`) | `login.mcpjam.com` |
| Staging (`wrangler deploy --env staging`, PR previews, `npm run dev`) | `dynamic-echo-14-staging.authkit.app` |

Both domains are the MCPJam tenant — the same one the inspector app authenticates against, so a user signed into the inspector can reach this worker.

`npm run dev` uses `--env staging` so local development binds against staging.
Both tenants must have **Client ID Metadata Document** enabled under
*Connect → Configuration* in the WorkOS dashboard — it's off by default, and
without it dynamic-client-registration MCP clients will fail to connect.

No secrets are required: JWKS is public, and Convex is called with the user's
own JWT.

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

Unauthenticated request — expect `401` with a `WWW-Authenticate` header:

```sh
curl -i http://localhost:8787/mcp
```

PRM discovery — expect `resource: http://localhost:8787/mcp` and the staging
AuthKit issuer:

```sh
curl -s http://localhost:8787/.well-known/oauth-protected-resource/mcp | jq
```

To hit `whoami`, connect the MCPJam Inspector (or any MCP client that supports
OAuth discovery) to `http://localhost:8787/mcp`; the client will auto-discover
the AuthKit issuer, run the OAuth flow, and call `whoami` with your
MCPJam user.

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

- `src/index.ts` — Worker entrypoint; serves the PRM metadata routes, enforces
  bearer-token auth on `/mcp`, attaches the verified token to `ctx.props`,
  and delegates to the Durable Object via `McpJamMcpServer.serve("/mcp")`.
- `src/auth.ts` — JWKS-backed JWT verification (`jose`) and the
  `WWW-Authenticate` / 401 helpers.
- `src/server.ts` — `McpJamMcpServer` (extends `McpAgent` from `agents`). Reads
  `this.props.bearerToken` inside each tool handler and forwards it to Convex.

Modeled after the WorkOS AuthKit MCP pattern used in
[`examples/mcp-apps/sip-cocktails`](../examples/mcp-apps/sip-cocktails/server-utils.ts),
adapted for Cloudflare Workers + Durable Objects.
