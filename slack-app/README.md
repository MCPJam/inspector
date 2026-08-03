# MCPJam Slack app

A Slack bot that turns conversations into MCPJam eval suites. Mention it (or DM
it) with what your MCP server should do, and it authors a runnable suite in your
MCPJam project and hands back a **Run it** button.

## Architecture

The bot has **no brain of its own**. It is a thin terminal over MCPJam's own
agent engine, exactly like the CLI and the MCP worker are thin over `/api/v1`:

```
Slack event → collect thread → POST /api/v1/projects/:projectId/agent → post reply
```

That endpoint (`mcpjam-inspector/server/routes/v1/agent.ts`) runs one assistant
turn server-side with a project-scoped workspace toolset, on a hosted model
billed to the project. Consequences worth knowing:

- **No LLM credentials live here.** There is no Anthropic/OpenAI key, no agent
  loop, no model config in this workspace — only an MCPJam API key.
- **The bot cannot start eval runs.** The agent's toolset is reads plus
  `create_eval_suite`; run operations are excluded server-side because a turn
  is unattended (`approvalMode: "auto-deny"`). Runs happen only when a human
  clicks **Run it**, which calls `POST /eval-runs` directly.
- **Every operation is clamped to `MCPJAM_PROJECT_ID`** by the server, not by
  prompt instructions.

### Files

| Path | What it does |
| --- | --- |
| `app.js` | Bolt app entry (Socket Mode) |
| `agent/mcpjam-client.js` | HTTP client for the MCPJam public API — turns, run starts, run polling |
| `agent/turn-runner.js` | Event dedupe (TTL), per-thread serialization, thread → message-history normalization |
| `listeners/events/run-and-reply.js` | Shared body for DM / mention triggers: run the turn, post the reply |
| `listeners/actions/run-suite-button.js` | The human-gated **Run it** button + the detached watcher that edits the message with the run outcome |
| `listeners/views/` | Block Kit builders (App Home, created-suite blocks, feedback) |
| `thread-context/` | Tracks which channel threads the bot is engaged in |

### Correctness details that are easy to break

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
| `MCPJAM_API_KEY` | yes | MCPJam API key (`sk_…`), minted at **Settings → API keys**. Scopes the bot to one organization. |
| `MCPJAM_PROJECT_ID` | yes | The project every turn operates in. From `GET /api/v1/projects` or the app URL. |
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

Not deployed yet — Socket Mode against a developer install is the current
dogfood path. Hosting (a Railway service modeled on `deploy-soundcheck.yml`)
and multi-tenant OAuth distribution are tracked as follow-ups; OAuth mode was
deliberately removed from v1 rather than shipped half-wired.
