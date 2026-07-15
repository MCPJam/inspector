# `@mcpjam/mcp`

Remote MCP server for MCPJam, hosted on Cloudflare Workers.

This package runs as a Cloudflare Worker backed by a Durable Object and exposes
an MCP endpoint at `/mcp`. It is a sibling to `sdk/` and `cli/` but is **not**
published to npm — clients connect to it remotely via URL.

## Status

Protected by WorkOS AuthKit. Tools are thin adapters over the shared platform
operation catalog in `@mcpjam/sdk/platform`; every call hits the Platform API
(`/api/v1`) with the session's own AuthKit JWT, so results respect the
caller's project access.

| Tool | What it does | Widget |
| --- | --- | --- |
| `show_servers` | Project servers with hosted doctor health probes | ✅ |
| `list_projects` | Projects the caller can access, most recently updated first | — |
| `list_project_servers` | Servers saved in a project (no probes) | — |
| `list_eval_suites` | Eval suites in a project, with latest-run summaries | ✅ |
| `list_eval_suite_runs` | Recent runs of a suite (by name or ID), newest first | ✅ |
| `run_eval_suite` | Start an async rerun of a suite; returns `runId` immediately | — |
| `get_eval_run` | Run status/result/summary — poll until terminal | ✅ |
| `list_eval_run_iterations` | Per-iteration results: tool calls, token usage, latency | ✅ |
| `get_eval_iteration_trace` | Full trace for one iteration (can be large) | — |
| `list_chatboxes` | Chatboxes published from a project | ✅ |
| `get_chatbox` | One chatbox's settings: model, system prompt, approval policy, servers | ✅ |
| `list_chat_sessions` | Chat sessions visible to the caller, optional project/status filter | — |

Widget-backed tools render as MCP Apps when — and only when — the client's
`initialize` request advertises the `io.modelcontextprotocol/ui` extension
with the MCP Apps MIME type; other clients get the same tools as plain
text + structured content (see `src/tools/sessionToolRegistrar.ts`). All
widgets ship in **one** Vite-bundled single-file app (`src/ui/app.tsx`):
each tool registers its own `ui://mcpjam/...` resource URI (hosts cache
templates per URI) serving the same HTML, and the worker tags the tool's
structured content with `widget: <view>` so the app routes the result to
the right view. The non-widget tools stay plain deliberately:
`list_projects`/`list_project_servers` defer to the richer `show_servers`,
`run_eval_suite` returns a receipt the run widgets supersede, and
`get_eval_iteration_trace`/`list_chat_sessions` are agent-oriented payloads
with no visual form.

Listing tools take an optional `project` (name or ID) and default to the most
recently updated accessible project. The eval-run polling tools
(`get_eval_run`, `list_eval_run_iterations`, `get_eval_iteration_trace`)
require the project the run belongs to — `run_eval_suite` and
`list_eval_suite_runs` return it, so the loop is self-contained.
`run_eval_suite` is the only non-read tool: it starts LLM iterations that
consume the organization's credits, and is annotated `readOnlyHint: false`
(but non-destructive) so hosts can gate it accordingly. By default the
platform connects the suite's saved server selection — the exact set the run
snapshot references; `servers` is an explicit override. Naming a disabled
server runs it (the platform authorizes eval runs by project membership; the
`enabled` toggle only shapes default connection sets), but stdio servers
never run hosted, explicitly named or not.

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

The verified bearer token is forwarded to the Platform API
(`PLATFORM_API_URL`, the Inspector `/api/v1` surface) on every tool call, so
the API sees the same WorkOS identity the main app does and applies its own
per-project authorization to listings, probes, and eval runs.

### AuthKit domains

| Target | `AUTHKIT_DOMAIN` |
| --- | --- |
| Production (`wrangler deploy --env production`, hostname `mcp.mcpjam.com`) | `login.mcpjam.com` |
| Staging (`wrangler deploy --env staging`, hostname `mcp-staging.mcpjam.com`) | `dynamic-echo-14-staging.authkit.app` |
| PR previews (`wrangler deploy --env preview`) and `npm run dev` | `dynamic-echo-14-staging.authkit.app` |

Both domains are the MCPJam tenant — the same one the inspector app authenticates against, so a user signed into the inspector can reach this worker.

`npm run dev` uses `--env staging` so local development binds against staging.
For developing against the **Home/MCPJam agent** locally, use `npm run dev:local`
(`--env dev`) instead — it binds to the dev AuthKit app and the local inspector
(`http://localhost:6274/api/v1`). The inspector's own `npm run dev` starts this
`dev:local` worker automatically (see `CONTRIBUTING.md`), so you normally don't
run it by hand.
Both tenants must have **Client ID Metadata Document** enabled under
*Connect → Configuration* in the WorkOS dashboard — it's off by default, and
without it dynamic-client-registration MCP clients will fail to connect.

No secrets are required: JWKS is public, and Convex is called with the user's
own JWT.

## Scripts

```sh
npm run dev         # wrangler dev → http://localhost:8787
npm run deploy:staging  # wrangler deploy --env staging → https://mcp-staging.mcpjam.com
npm run deploy      # wrangler deploy → NOTE: named envs don't merge with the top-level,
                    # so a bare deploy lands on an unrouted default worker. Use --env.
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

To hit `show_servers`, connect the MCPJam Inspector (or any MCP client that
supports OAuth discovery) to `http://localhost:8787/mcp`; the client will
auto-discover the AuthKit issuer, run the OAuth flow, and call `show_servers`
with either no arguments or `{ "project": "<project name or id>" }`.

## Delivery model

`@mcpjam/mcp` is a private workspace deploy target, not a published npm package.
It is ignored by Changesets alongside `@mcpjam/soundcheck`.

The intended rollout path is:

- open/push a PR touching `mcp/**` → `pr-mcp-preview.yml` deploys a
  dedicated per-PR worker named `mcpjam-mcp-pr-<n>` at
  `https://mcpjam-mcp-pr-<n>.<subdomain>.workers.dev` and posts the URL
  as a PR comment. Each push overwrites the same worker, so the URL is
  stable for the life of the PR. The live `mcpjam-mcp-staging` worker
  is **not** touched. PR previews deploy with `--env preview` — they
  deliberately avoid `--env staging` because staging owns the exclusive
  `mcp-staging.mcpjam.com` custom domain.
- close the PR → the per-PR worker is deleted.
- push to `main` → `deploy-mcp-staging.yml` auto-deploys the live
  `mcpjam-mcp-staging` worker at `https://mcp-staging.mcpjam.com/mcp`.
- `mcp.mcpjam.com` is configured under `env.production` in
  `wrangler.jsonc` but has no deploy workflow yet — manual production
  deployment remains a separate, explicit step.

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
  `this.props.bearerToken` inside each tool handler and forwards it to the
  Platform API via `PlatformApiClient`.
- `src/tools/platformTools.ts` — registers the `@mcpjam/sdk/platform`
  operation catalog (plain and widget-backed per
  `PLATFORM_TOOL_WIDGET_VIEWS`) and houses the shared operation-to-tool
  adapter.
- `src/tools/showServers.ts` — the `show_servers` tool, registered with the
  same widget plumbing under its own resource URI.
- `src/shared/platform-widgets.ts` — the worker↔widget contract: view ids,
  per-tool resource URIs, and the `widget` payload tag.
- `src/ui/app.tsx` — the single MCP Apps bundle: shared shell
  (`src/ui/shared/`) plus one view per widget-backed tool
  (`src/ui/views/`).

Modeled after the WorkOS AuthKit MCP pattern used in
[`examples/mcp-apps/sip-cocktails`](../examples/mcp-apps/sip-cocktails/server-utils.ts),
adapted for Cloudflare Workers + Durable Objects.
