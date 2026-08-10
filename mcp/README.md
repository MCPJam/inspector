# `@mcpjam/mcp`

Remote MCP server for MCPJam, hosted on Cloudflare Workers.

This package runs as a **stateless** Cloudflare Worker and exposes an MCP
endpoint at `/mcp`. It is a sibling to `sdk/` and `cli/` but is **not**
published to npm — clients connect to it remotely via URL.

Serving is `createMcpHandler` from `@modelcontextprotocol/server` (v2): a fresh
server is built per HTTP request from one factory, which serves the modern
2026-07-28 revision and — through the default `legacy: "stateless"` posture —
2025-era Streamable HTTP clients from the same endpoint. There is no Durable
Object and no session, so nothing survives a request: no session to hijack, no
bearer at rest. 2025-era clients get no `Mcp-Session-Id` and a spec-compliant
`405` on `GET`/`DELETE`.

## Status

Protected by WorkOS AuthKit. Tools are thin adapters over the shared platform
operation catalog in `@mcpjam/sdk/platform`; every call hits the Platform API
(`/api/v1`) with the request's own bearer — the caller's AuthKit JWT, or a
guest token minted lazily on first tool execution for an anonymous request —
so results respect the caller's project access.

| Tool | What it does | Widget |
| --- | --- | --- |
| `get_me` | Return the account associated with the current API credential. | — |
| `list_models` | List the public hosted model catalog available to MCPJam callers. | — |
| `list_projects` | List the MCPJam projects the caller can access, most recently updated first. | — |
| `list_project_servers` | List the MCP servers saved in an MCPJam project. | — |
| `create_project_server` | Save a new MCP server in a project, including optional credentials. | — |
| `get_project_server` | Read one saved MCP server by project and server id. | — |
| `update_project_server` | Update saved MCP server metadata or rotate/clear credentials. | — |
| `delete_project_server` | Soft-delete a saved MCP server from a project. | — |
| `diagnose_server` | Diagnose a saved MCP server's connection: probe the URL, connect, initialize, and report capabilities and what failed. | — |
| `list_server_tools` | List the tools a saved MCP server exposes: names, descriptions, and input schemas. | — |
| `call_server_tool` | Execute a tool on a saved MCP server and return its result. | — |
| `list_server_prompts` | List the prompts a saved MCP server exposes: names, descriptions, and arguments. | — |
| `get_server_prompt` | Render a prompt from a saved MCP server with the given arguments and return its messages. | — |
| `list_server_resources` | List the resources a saved MCP server exposes: uris, names, and mime types. | — |
| `read_server_resource` | Read one resource from a saved MCP server by uri and return its contents. | — |
| `check_host_compatibility` | Check whether a saved MCP server's tools and widgets work on each AI host (Claude, ChatGPT, Cursor, Copilot, Codex, Goose, Mistral, n8n, Perplexity, Cline). | — |
| `list_eval_suites` | List the eval suites saved in an MCPJam project, with latest-run summaries and pass-rate trends. | ✅ |
| `list_eval_suite_runs` | List recent runs of an eval suite, newest first, with status, pass/fail result, and summary counts. | ✅ |
| `run_eval_case` | Start an asynchronous run of ONE case in an existing eval suite — a persisted, fully-queryable run scoped to just that case (inspect it with get_eval_run / list_eval_run_iterations / get_eval_run_steps, same as a full run). | — |
| `run_eval_suite` | Start an asynchronous rerun of an existing eval suite. | — |
| `create_eval_suite` | Create a runnable eval suite from authored test cases. | — |
| `get_eval_suite` | Fetch one eval suite's full settings: environment (servers), execution config (model/system prompt/temperature), hosts, match options, checks, LLM-as-judge, schedule. | — |
| `update_eval_suite` | Edit an eval suite's settings: name, description, environment servers, execution config (model/system prompt/temperature), hosts, minimum accuracy, match options, checks, and LLM-as-judge. | — |
| `delete_eval_suite` | Permanently delete an eval suite and all its cases and runs. | — |
| `set_eval_suite_schedule` | Enable or disable automatic scheduled runs for a suite, and set the interval. | — |
| `set_eval_suite_environments` | Attach project environments to an eval suite, replacing whatever it had. | — |
| `list_eval_cases` | List the test cases in an eval suite, with their ids and configuration. | — |
| `get_eval_case` | Fetch one eval test case's full definition. | — |
| `create_eval_case` | Add one test case to an eval suite. | — |
| `update_eval_case` | Edit an eval test case. | — |
| `delete_eval_case` | Permanently delete one test case from an eval suite. | — |
| `generate_eval_cases` | AI-generate test cases from the suite's server tools and persist them into the suite. | — |
| `get_eval_run` | Get the status, pass/fail result, and summary counts of an eval run. | ✅ |
| `list_eval_run_iterations` | List per-iteration results for an eval run: pass/fail, expected vs actual tool calls, token usage, and latency. | ✅ |
| `get_eval_iteration_trace` | Fetch the full trace for one eval iteration: the complete message history plus expected-vs-actual tool-call analysis. | — |
| `get_eval_run_steps` | Fetch one row per authored test step for an eval iteration, in order: each step's status (ok / fail / skipped / pending), the reason, and evidence (screenshot/video URLs, widget tool calls). | — |
| `cancel_eval_run` | Cancel an in-flight eval run. | — |
| `list_project_environments` | List the project environments in an MCPJam project. | — |
| `get_project_environment` | Show one project environment: its host, optional standalone server group, pinned skill selection, pinned plugin versions, and its current `revision` (which you pass as `expectedRevision` when updating it). | — |
| `resolve_project_environment` | Resolve a project environment to the exact execution inputs a run would use right now: the host's current config, the closed server set (including servers contributed by pinned plugin versions), and the resolved plugin versions. | — |
| `list_chatboxes` | List the chatboxes published from an MCPJam project: name, access mode, attached servers, and share link. | ✅ |
| `get_chatbox` | Get one chatbox's read-only settings: model, system prompt, temperature, tool-approval policy, and resolved servers. | ✅ |
| `list_chat_sessions` | List chat sessions visible to the caller, most recent activity first. | — |

<!-- The rows above are the CATALOG, not a hand-written summary: they are
     checked against `PLATFORM_CATALOG_OPERATIONS` by
     `tests/readme-tool-table.test.ts`. This table had drifted to 17 of 43
     tools before that test existed. Pinned by a test rather than emitted by a
     generator on purpose — a generator makes the file untouchable and its
     output unreviewed, while a test lets a human write the row and fails when
     the row stops being true. -->

Widget-backed tools always advertise their MCP Apps `_meta` and always serve
their `ui://` resource. Statelessly there is no memory of the client's
`initialize` capabilities when a later request arrives, so per-request gating
is impossible; always-advertise is a SHOULD deviation from SEP-1865 that leaves
the MUST (a meaningful `content` array) intact, and `_meta.ui` is inert for
hosts that do not render apps (see `src/tools/sessionToolRegistrar.ts`). All
widgets ship in **one** Vite-bundled single-file app (`src/ui/app.tsx`):
each tool registers its own `ui://mcpjam/...` resource URI (hosts cache
templates per URI) serving the same HTML, and the worker tags the tool's
structured content with `widget: <view>` so the app routes the result to
the right view. The non-widget tools stay plain deliberately:
`list_projects`/`list_project_servers` defer to the richer `show_servers`,
`run_eval_suite` returns a receipt the run widgets supersede, and
`get_eval_iteration_trace`/`list_chat_sessions` and the project-environment
tools are agent-oriented payloads with no visual form.

Listing tools take an optional `project` (name or ID) and default to the most
recently updated accessible project. The eval-run polling tools
(`get_eval_run`, `list_eval_run_iterations`, `get_eval_iteration_trace`)
require the project the run belongs to — `run_eval_suite` and
`list_eval_suite_runs` return it, so the loop is self-contained.
The eval authoring/editing tools are writes, annotated `readOnlyHint: false`
(the deletes and `cancel_eval_run` additionally announce `destructiveHint`) so
hosts can gate them. Three of them SPEND: `run_eval_suite` and `run_eval_case`
start LLM iterations, and `generate_eval_cases` calls an authoring model — all
against the organization's credits. By default the
platform connects the suite's saved server selection — the exact set the run
snapshot references; `servers` is an explicit override. Naming a disabled
server runs it (the platform authorizes eval runs by project membership; the
`enabled` toggle only shapes default connection sets), but stdio servers
never run hosted, explicitly named or not.

### Project environments

A **project environment** is a named execution bundle — one host, an optional
standalone server group, pinned skills, pinned plugin versions — that a suite
can run against instead of a loose server selection. Attach them to a suite
with `set_eval_suite_environments`; from then on `run_eval_suite` /
`run_eval_case` take an `environment` (name or ID) naming which one to use.
A suite with exactly one attached environment uses it automatically; a suite
with several requires the argument, and the error names the candidates.
`environment` and `servers` are mutually exclusive — an environment supplies a
closed server set that an override cannot change.

An environment-backed run records the environment and the exact revision it
executed against, and `get_eval_run` reports that triple — so an agent can
confirm *which* configuration produced a result long after the environment has
been edited. A run that used a saved server selection has no environment to
record, and reports `environment: null`.

The environment tools other than `set_eval_suite_environments` are read-only.
Creating, editing, and archiving environments stays CLI-only for now:
those writes are revision-guarded (`expectedRevision`), and giving an agent a
safe path through optimistic concurrency is a separate design question.

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

No secrets are required: JWKS is public, and the Platform API is called with
the caller's own bearer.

**The trust boundary is the Inspector, not Convex.** This worker never talks to
Convex. Every tool goes through `/api/v1` on the Inspector, which validates the
bearer, applies the guest allowlist, and mints whatever delegated credential
Convex needs. That is what keeps this worker credential-free and what makes
"the caller's own access" a property enforced somewhere other than here — an
earlier version of this paragraph said Convex was called directly, which
described a boundary that does not exist and made the worker look more
privileged than it is.

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
- production (`mcp.mcpjam.com`) is deployed by `deploy-mcp-prod.yml`.
  **workflow_dispatch ONLY** — there is deliberately no auto-deploy on merge,
  matching `release.yml`'s view that production is a last deliberate step
  rather than a side effect of merging. Two ways to invoke it: Soundcheck's
  "Deploy MCP production" tile, or the GitHub Actions UI. Reviewer gating
  lives on the `mcp-production` GitHub Environment rather than in the
  workflow file, so it applies to both paths equally.

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
  bearer-token auth on `/mcp`, owns the `/mcp` CORS contract (the v2 handler is
  deliberately validation-free and emits none), and hands the verified bearer
  to the handler as pass-through `authInfo`.
- `src/auth.ts` — JWKS-backed JWT verification (`jose`) and the
  `WWW-Authenticate` / 401 helpers.
- `src/server.ts` — the `createMcpHandler` factory. Builds a fresh `McpServer`
  per request, resolves the bearer (verified token, or a lazily-minted guest
  for an anonymous request), and forwards it to the Platform API via
  `PlatformApiClient`. Also owns the isolate-local guest-token cache.
- `src/tools/sessionToolRegistrar.ts` — thin helper over v2
  `registerTool`/`registerResource` that pairs a widget-backed tool with its
  `ui://` resource and MCP Apps `_meta`.
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
adapted for a stateless Cloudflare Worker.
