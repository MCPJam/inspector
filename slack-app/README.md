# MCPJam Slack app

A Slack bot that turns conversations into MCPJam eval suites. Mention it (or DM
it) with what your MCP server should do, and it authors a runnable suite in your
MCPJam project and hands back a **Run it** button.

## Architecture

The bot has **no brain of its own**. It is a thin terminal over MCPJam's own
agent engine, exactly like the CLI and the MCP worker are thin over `/api/v1`:

```text
Slack event → collect thread → POST /api/v1/projects/:projectId/agent → post reply
```

That endpoint (`mcpjam-inspector/server/routes/v1/agent.ts`) runs one assistant
turn server-side with a project-scoped workspace toolset, on a hosted model
billed to the project. Consequences worth knowing:

- **No LLM credentials live here.** There is no Anthropic/OpenAI key, no agent
  loop, no model config in this workspace — only credentials that name a caller.
- **The bot cannot start eval runs.** The agent's toolset is reads plus authoring
  writes; run operations are excluded server-side because a turn is unattended
  (`approvalMode: "auto-deny"`). Runs happen only when a human clicks a button,
  and the CLICKER is the one authorized to run them — never the person whose
  message caused the proposal.
- **Every operation is clamped to one project** by the server, not by prompt
  instructions. Which project comes from the thread's binding, else the acting
  user's default project, else `MCPJAM_PROJECT_ID` on the legacy path.

### Files

| Path | What it does |
| --- | --- |
| `app.js` | Bolt app entry — picks OAuth (HTTP) or Socket Mode from config presence |
| `installations/store.js` | Bolt `InstallationStore` over Convex + Vault, with the lifecycle-busted token cache |
| `installations/backend-client.js` | Service-token client for the backend's `/slack/installations/*` routes |
| `installations/bot-scopes.js` | `BOT_SCOPES` — must mirror `manifest.json` |
| `installations/event-claims.js` | Durable per-event claims (replay a stored reply instead of re-running) |
| `agent/turn-target.js` | Whose credentials and which project a turn runs with |
| `agent/connect-link.js` | Mints a per-user connect URL from the inspector's link bridge |
| `listeners/actions/account-actions.js` | App Home project picker + disconnect |
| `listeners/middleware/tenant-guard.js` | Global middleware: resolves the tenant, drops workspaces we have no credentials for |
| `listeners/events/app-lifecycle.js` | `app_uninstalled` / `tokens_revoked` — revoke + synchronous cache purge |
| `agent/mcpjam-client.js` | HTTP client for the MCPJam public API — turns, run starts, run polling |
| `agent/turn-runner.js` | Event dedupe (TTL), per-thread serialization, thread → message-history normalization |
| `listeners/events/run-and-reply.js` | Shared body for DM / mention triggers: run the turn, post the reply |
| `listeners/actions/run-suite-button.js` | The human-gated **Run it** button + the detached watcher that edits the message with the run outcome |
| `listeners/views/` | Block Kit builders (App Home, created-suite blocks, feedback) |
| `thread-context/` | Tracks which channel threads the bot is engaged in |

### Correctness details that are easy to break

- **Identity is per-ACTOR, not per-workspace.** `resolveTurnTarget` decides in
  a fixed order: thread binding → the replier's default project → the legacy
  shared key. The thread binding wins because without it a thread would drift
  between projects as different people replied, and a suite would land
  somewhere nobody expected.
- **An unlinked user is a UX state, not an error.** They get a connect button;
  a linked user with no default project gets a project prompt. Both are
  ephemeral in channels so a message about one person's account does not
  notify the whole thread.
- **The bot never holds a user token.** It presents its own `slk_` credential
  plus the Slack team/user headers, and the server resolves the linked user.
  Delegated JWTs are portable 2-hour org credentials; a compromised bot must
  not be able to harvest them.
- **The SessionStore is a cache over the durable thread binding**, not the
  source of truth — before that, the bot went deaf in every engaged thread
  after a restart with no indication why.
- **Never blind-retry a turn.** The agent endpoint is not idempotent — a lost
  response may still have persisted a suite. Dedupe lives at the trigger
  (`EventDedupe`, keyed on `channel + event ts`, with a TTL so a *delayed*
  Slack retry after completion is still caught). `mcpjam-client` makes exactly
  one attempt per call on purpose.
- **Turns are serialized per thread** (`KeyedQueue`), so two rapid messages in
  one thread can't race into duplicate suites.
- **Thread history is filtered through the triggering timestamp** — messages
  newer than the trigger belong to the next turn.
- **Bolt v5 auto-acks Events API events** before listeners run, so a long
  listener body is fine. Block actions (the Run button) still need an explicit
  `ack()` first.
- **Speaker names are not resolved.** That would need the `users:read` scope,
  which the manifest deliberately does not request.
- **The message history the bot sends is capped in bytes, not just
  characters** (`turn-runner.js`), mirroring the server's per-message and
  aggregate UTF-8 limits. Character-only caps let emoji/CJK threads 400.
- **`scopes` must be passed explicitly to `App()`.** Bolt's HTTPReceiver
  defaults it to `undefined` and forwards `scopes ?? []`, so omitting it
  produces an install URL requesting ZERO bot scopes. That install *succeeds*
  and then fails every API call with `missing_scope`, per workspace, with
  nothing at install time pointing at the cause. `BOT_SCOPES` must stay
  identical to `manifest.json`.
- **There is no custom `authorize`.** Bolt throws if given both `authorize`
  and OAuth installer options, and with installer options it derives
  authorization from `installationStore.fetchInstallation`. The installation
  store IS the authorization path.
- **A backend outage is not an uninstall.** `fetchInstallation` throws on a
  transport failure and returns an installation or throws otherwise; it never
  reports "not installed" because we could not ask. Telling a workspace to
  reinstall over a network blip is the failure that shape prevents.
- **The token cache is only safe because lifecycle events bust it.**
  `app_uninstalled`, a bot-token `tokens_revoked`, and reinstall all call
  `purgeInstallation()` synchronously. Without that, a revoked workspace would
  keep being served for the full 5-minute TTL.
- **`tokens_revoked` is not `app_uninstalled`.** It only counts as a
  revocation when the stored `botUserId` appears in `event.tokens.bot`; a user
  revoking their own token must not take the workspace's bot offline.
- **Sign in with Slack never mixes into the bot install URL.** Slack rejects an
  authorize request combining SIWS user scopes with bot scopes; the `openid` /
  `profile` scopes in the manifest are used only by the inspector's separate
  account-link bridge.

## Setup

From the repo root, `npm install` covers this workspace. You also need the
[Slack CLI](https://docs.slack.dev/tools/slack-cli/) and a Slack workspace where
you can install apps.

Copy the env sample and fill it in:

```sh
cd slack-app
cp .env.sample .env
```

| Variable | Required | Meaning |
| --- | --- | --- |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` / `SLACK_STATE_SECRET` | OAuth mode | Presence of all three selects OAuth mode. `SLACK_STATE_SECRET` is ours to choose — any high-entropy string. |
| `SLACK_SIGNING_SECRET` | OAuth mode | Verifies inbound request signatures. |
| `MCPJAM_CONVEX_HTTP_URL` / `INSPECTOR_SERVICE_TOKEN` | OAuth mode | Where installations are stored. The app refuses to boot if OAuth is configured without them. |
| `MCPJAM_SLACK_SERVICE_TOKEN` | OAuth mode | The bot's own service credential (`slk_…`), sent with `x-mcpjam-slack-team-id` / `x-mcpjam-slack-user-id` so the inspector resolves the acting user from their account link. Grants nothing by itself. The inspector holds its SHA-256 as `MCPJAM_SLACK_SERVICE_TOKEN_HASH`. |
| `MCPJAM_API_KEY` | legacy workspace | MCPJam API key (`sk_…`), minted at **Settings → API keys**. Org-scoped, so it is released only for the workspace flagged `isLegacyWorkspace`, and only for a Slack user who has not linked an account. Everyone else acts as themselves through `MCPJAM_SLACK_SERVICE_TOKEN`. |
| `MCPJAM_PROJECT_ID` | legacy workspace | The fallback project for the legacy path. A linked user's project comes from the thread's binding, else their default project. |
| `MCPJAM_BASE_URL` | no | API host. Defaults to `https://app.mcpjam.com`; point at a local inspector (`http://localhost:6274`) for development. |
| `MCPJAM_APP_URL` | no | Where deep links posted into Slack point. Defaults to `MCPJAM_BASE_URL`; in local dev the UI (`:5173`) differs from the API (`:6274`). |

## Development

```sh
cd slack-app
slack run          # installs the dev app + starts Socket Mode with hot reload
```

`slack run` must be run from this directory (it needs `.slack/`). On first run
it will ask which workspace to install into; the choice is saved locally to
`.slack/apps.dev.json` (git-ignored).

Then DM the bot, or `@MCPJam` it in a thread:

> create an eval suite for the excalidraw server with one case: prompt "draw a
> small house", and assert that a drawing/create tool gets called

## Tests

```sh
npm run verify -w @mcpjam/slack-app   # test + check + lint (what CI runs)
npm test    -w @mcpjam/slack-app      # node:test only
```

Tests are `node:test` with no network: the API client takes an injectable
`fetchImpl`, and Slack clients are hand-stubbed.

## Deployment

Hosted on Railway in its own project, `mcpjam-slack-app`, deployed by
`.github/workflows/deploy-slack-app.yml` on pushes that touch `slack-app/**`
(mirroring `deploy-soundcheck.yml`).

In OAuth mode the service **serves HTTP on `$PORT`** — Bolt's HTTP receiver
owns `/slack/events`, `/slack/install`, and `/slack/oauth_redirect` — so it
needs a public domain, and the manifest's request URLs point at it.

**The service is pinned to ONE replica and must stay that way.** The
installation token cache (purged synchronously on revocation) and the
per-link rate buckets are process-local: with two replicas, a purge on
replica A would leave replica B serving a revoked token until its own TTL
lapsed, and the effective rate limit would be N× the intended one. Shared
invalidation and rate state are deliberately deferred until we need to scale
horizontally.

Two pieces of Railway config are load-bearing and easy to get wrong:

- **Config as code = `slack-app/railway.toml`.** Without it Railway falls back
  to the repo-root `railway.json` and builds the *inspector's* Dockerfile
  (playwright and all). Setting `RAILWAY_DOCKERFILE_PATH` is NOT enough — the
  root config-as-code file wins over the variable.
- **Root directory = `/`.** The build context has to be the monorepo root
  because the lockfile lives there; `Dockerfile` paths are repo-relative.

### Why `undici` is a direct dependency

`@slack/socket-mode` requires `undici` at runtime and declares it properly,
but in this monorepo the hoisted copy is also pinned by `miniflare` (a dev
dependency elsewhere), so npm records the single hoisted entry as `dev` — and
a workspace-scoped install then omits it, crashing the container with
`Cannot find module 'undici'`. Declaring it here makes the attribution
unambiguous. Remove it only if that hoist stops colliding.

### Deploying by hand

```sh
railway link --project mcpjam-slack-app   # once per machine
railway up --service mcpjam-slack-app --ci
```

Multi-tenant OAuth distribution remains a follow-up; OAuth mode was
deliberately removed from v1 rather than shipped half-wired.
