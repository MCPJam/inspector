---
name: mcpjam-cloud
description: Drive MCPJam Cloud from the `mcpjam cloud` CLI — sign in, pick a project, put servers into it (tunnels and connections), manage environments, clients, secrets, sandbox images and Cloud Skills, run hosted evals, launch Swarms goals with personas, publish studies to outside testers, read Playground sessions, and stream traces. Use when the user mentions their MCPJam account or project, `mcpjam cloud`, hosted or scheduled evals from a terminal or CI, tunneling a local server into MCPJam, goals, swarms, personas, studies, sandbox images, or project secrets. For testing a server directly from this machine, use the `mcp-inspector` skill instead.
---

# MCPJam Cloud CLI

`mcpjam cloud …` acts on the user's MCPJam account: their organizations, projects, and everything saved in them. Many of these commands spend the organization's model credits or change shared state other people rely on. Know which project you are in before you run anything that writes.

## Setup

- Install with `npm i -g @mcpjam/cli`, or prefix commands with `npx -y @mcpjam/cli@latest` instead of `mcpjam`. `mcpjam cloud <group> <command> --help` is the authoritative flag list; read it before passing a flag this skill does not name. It does not prove a command exists: `<group> <unknown> --help` prints the parent group's help and exits `0`. Check that the command appears in the group's command list.
- Top-level commands (`mcpjam server`, `mcpjam tools`, `mcpjam oauth`, …) are local and use no account. These use MCPJam credentials: `mcpjam cloud …`, `mcpjam registry …`, the hosted `mcpjam readiness start|status|list|cancel|report` commands, and `mcpjam test`, which needs an MCPJam login or `sk_` key for every run, BYOK included. `mcpjam conformance run` uploads its results whenever `MCPJAM_API_KEY` is set. The single-suite conformance commands upload only with `--upload`.
- `mcpjam cloud login` signs in to MCPJam. `mcpjam oauth login` signs in to an MCP server under test. They never stand in for each other.
- Credentials, first match wins: `--api-key sk_…`, then `MCPJAM_API_KEY`, then the stored `mcpjam cloud login` session. Only `sk_` keys are accepted. `--api-key`, `--api-url`, and `--api-header` belong to `mcpjam cloud` and work before or after the subcommand.
- Start every session with `mcpjam cloud status`. It makes no network call and reports which credential, server, and project the next command would use, with keys redacted. `mcpjam cloud whoami` confirms the account against the server.
- Never print, echo, or paste an API key or secret value into a command line, a file you commit, or your reply.
- Pass `--quiet --format json` when you parse output. Successful commands print an audience line (`Using MCPJam Cloud as … · project: …`) to stderr unless `--quiet` is set.

## Project scope

Most commands act on one project, chosen in this order: `--project <id-or-name>`, a `project` field in `--file` / `--json`, `MCPJAM_PROJECT`, the nearest `.mcpjam/project.json` (written by `mcpjam cloud link`), then the most recently updated project you can see.

- The last fallback is fine for reading. Before anything that creates inside a project, edits, deletes, publishes, or spends, pass `--project` explicitly, naming the project the user asked for. `mcpjam cloud projects create` is the exception: it makes a new project, so it takes no `--project`. A link or `MCPJAM_PROJECT` can point at a different one. For writes that take `--file` or `--json`, also check that the document's `project` field matches.
- `mcpjam cloud link [project]` pins the current Git worktree to a project (no secrets in the file). `mcpjam cloud link --remove` undoes it.
- `mcpjam cloud projects capabilities --project <p>` reports the user's role, the organization's betas, plan limits, and a `can` block. Read it before scripting authoring, launches, or publishing; a `403` with `FEATURE_UNAVAILABLE` means the organization does not have that feature, so tell the user instead of retrying.
- IDs do not travel between projects. A run, environment, or goal ID from one project is not found in another.

## What lives where

| Group | What it covers | Key commands |
|---|---|---|
| `cloud organizations`, `cloud projects` | Find orgs and projects; create, update, delete projects | `organizations list`, `projects list`, `projects capabilities`, `projects status` |
| `cloud projects servers` | Saved MCP servers in a project | `projects servers`, `projects servers connect --url <url>`, `connect-status`, `connect-cancel` |
| `cloud tunnel` | Expose a local server through a public MCPJam URL and save it as a project server | `tunnel --server <name> <url>`, `tunnel --server <name> -- <command>` |
| `cloud clients` (alias `hosts`) | Saved client configs (model, system prompt, host behavior) | `templates`, `list`, `get`, `create`, `update`, `servers` |
| `cloud environments` | A client plus servers plus pinned skills, secrets, plugins and image: what evals, goals and studies run against | `list`, `get`, `resolve`, `create`, `update`, `ensure-adhoc`, `archive` |
| `cloud secrets` | Write-only project credentials delivered to runs | `list`, `show`, `set`, `update`, `rm` |
| `cloud images` | Custom sandbox images (blueprints) for Computer | `validate`, `create`, `build`, `logs`, `use`, `promote` |
| `cloud skills` | Read the project's Cloud Skills and their IDs (authoring is in the app) | `list`, `get` |
| `cloud eval` | Hosted eval suites and runs | `list`, `run`, `status`, `iterations`, `steps`, `compare`, `gate`, `validate`, `export` |
| `cloud personas`, `cloud swarms`, `cloud goals` (alias `journeys`) | Swarms: synthetic users pursuing goals across environments | `personas create`, `goals create`, `goals get`, `goals run`, `goals status`, `goals scorecard` |
| `cloud studies` (alias `scenarios`) | Publish an environment to outside testers and read what they did | `publish`, `sessions`, `session`, `metrics`, `findings`, `rotate-link` |
| `cloud sessions` | Playground chat sessions: list, search, send a turn, read transcript and spans | `list`, `search`, `send`, `show`, `trace`, `browser` |
| `cloud trace-destinations` (alias `traces`) | Stream the organization's traces to an OTLP/HTTP endpoint | `list`, `show`, `create`, `test`, `pause`, `resume`, `backfill` |
| `registry` | Search MCP directories and install a listing into a project | `search`, `show`, `install` |
| `cloud feedback` | Report a bug in MCPJam itself to the MCPJam team | `feedback --kind <kind> --summary <text>` |

## Workflows

### Get a server into the project

- Public HTTPS server: `mcpjam cloud projects servers connect --url <url> --project <p>`. Always pass `--project`. With no `--project`, `MCPJAM_PROJECT`, or linked project, the request stops at `awaiting_project`, which needs a person in a browser even for a server with no auth.
  - Read `status` in the result. A browser is needed only when it is `awaiting_project` or `awaiting_authorization`. In that case the command prints a private link and opens a browser unless `--no-browser` is set; pass the link to the user rather than completing consent yourself, and never post it anywhere shared. Some CLI versions print a link line for other statuses too; go by `status`, not by the link.
  - `ready` means the server is saved in the project. If `server.enabled` is `false`, someone disabled that server on purpose. Tell the user; do not run `servers update --body '{"enabled":true}'` yourself.
  - Never edit server state to get past connect. A `failed` status carries an `error`; report it.
  - A pending request holds one of five concurrent-connection slots for up to an hour; cancel abandoned ones with `connect-cancel --request <id>`.
- Local server: `mcpjam cloud tunnel --server <name> --project <p> http://localhost:3000/mcp`, or for stdio `mcpjam cloud tunnel --server <name> --project <p> -- node server.js`. The tunnel runs until interrupted, so start it in the background. Its public URL embeds a bearer secret, and every re-run rotates it; an existing server with that name is repointed at the tunnel.
- `mcpjam cloud projects status --project <p>` runs a hosted doctor against every saved server.

### Change an environment

Environments are versioned. Read before you write:

1. `mcpjam cloud environments get --environment <id-or-name> --project <p>` and note `revision`.
2. `mcpjam cloud environments update --environment <id-or-name> --project <p> --expected-revision <n> …` changes only the fields you pass. A revision conflict means someone else edited it; read again instead of forcing.
3. `mcpjam cloud environments resolve --environment <id-or-name> --project <p>` previews exactly what a run would get: client config, closed server set, and pinned plugin versions.

Flags do not carry over between commands, so pass the same `--project` to each step. `environments ensure-adhoc` returns the same unnamed environment for the same composed stack, so it is safe to repeat.

### Run hosted evals from the CLI

1. `mcpjam cloud eval list --project <p>` to find the suite. For a local suite file, `mcpjam cloud eval validate --file <path>` checks it offline first.
2. Before launching, tell the user runs × cases × iterations and get a yes; this count is the only pre-launch cost check. `--environment`, `--client`, and `--all-targets` start one paid run per target, and `--iterations` multiplies every case. Count the cases with `mcpjam cloud eval cases list --suite <id-or-name> --project <p>`, or read `suite.enabledCases` from `eval validate --file <path>` for a local file. The CLI has no separate disclosure step. In human format, `eval run` prints a `Pre-run disclosure:` block (models, where they route, capture, retention) just before it creates the run, without pausing, and it says nothing about cost. With `--format json` that block is not printed; the receipt carries a `disclosure` field after launch.
3. `mcpjam cloud eval run --suite <id-or-name> --project <p> --idempotency-key <key>` starts the run and **spends**. Add `--wait` to block until every started run is terminal; `--wait-timeout <ms>` caps the wait. The default is 600000 plus up to 31 minutes for a run held for its judge; setting `--wait-timeout` removes those extra 31 minutes.
4. Without `--wait`, poll `mcpjam cloud eval status --run <id> --project <p>`. Never relaunch to poll. Run statuses: `pending`, `running`, and `grading` (every trial done, waiting for the judge) are still going; `completed`, `failed`, `cancelled`, and `timed_out` are final. Only `completed` carries a verdict in `result`.
5. On anything but a pass, triage in this order: `eval status` (the verdict and its decision summary, including each stage's state), then `mcpjam cloud eval iterations --run <id> --project <p>` (paginated; follow the cursor) for the failing iteration and its error, then `mcpjam cloud eval steps --run <id> --iteration <id> --project <p>` for the step that failed and its evidence. `eval trace`, `eval screenshot`, and `eval video` fetch more.
6. `mcpjam cloud eval compare --run <id> --project <p> --gate-regressions` exits `1` on a statistically significant pass-rate regression against the previous completed run; without `--gate-regressions` it does not gate pass rate. `mcpjam cloud eval gate --run <id> --project <p> --min-pass-rate-percent <n>` applies an absolute threshold. Both turn a finished run into a CI exit code.

Exit codes for `eval run --wait` (without `--wait`, `eval run` exits `0` once the launch succeeds):

| Code | Meaning |
|---|---|
| `0` | Every waited run completed and passed. |
| `1` | A run completed with `result: "failed"`. Nothing else produces `1`. |
| `2` | Usage or configuration error: an invalid suite file, a bad `--api-url`, a legacy `mcpjam_…` key, or an organization AI-key policy refusal. Fix the command; retrying it unchanged does not help. |
| `3` | Auth failed: no credential, or it was rejected at launch or during the wait. `LOGIN_DEPLOYMENT_MISMATCH` means the stored login belongs to a different MCPJam server than the one selected; run `mcpjam cloud login` for that server or use an `sk_` key for it. |
| `4` | Setup or launch failed before evaluation, including a billing or credit refusal at launch. |
| `5` | No valid verdict: an `inconclusive` result, a run whose status is `failed`, `cancelled`, or `timed_out` (a run stopped by credit exhaustion lands here), or a wait that hit its deadline with the run still going. |

`result: "failed"` (exit `1`) is a verdict: the run finished and its cases failed. `status: failed` (exit `5`) means the run itself did not finish, so there is no verdict.

Several targets merge worst-of in the order `1 > 3 > 4 > 5 > 0`. `2` is not in the merge because a usage or policy refusal stops the command before any run starts. `eval gate` uses its own codes: `0` passed or waived, `1` the gate failed, `2` usage error, `3` incomplete (cancelled, timed out, network failure, or a run that cannot be gated).

A run's decision summary carries a `nextAction` that can say to check the server connection when the cause was a model or credit failure, even with the `connection` and `discovery` stages `passed`. Trust the stage states and the iteration's error over that line. This is a known bug, fixed by https://github.com/MCPJam/inspector/pull/7873.

`eval judge` and `eval judge-backtest` also spend. The `run-mcpjam-evals` skill covers the same loop through MCPJam's hosted MCP tools and has the triage decision tree; `mcpjam-eval-import` converts an existing test corpus into a suite file.

### When a run stops for credits

A launch refusal (exit `4`) or a run that stops partway (exit `5`) with `user_rate_limit`, a daily or monthly MCPJam model limit, or a required platform fee means the organization is out of credits. In this order:

1. Tell the user the immediate fix for their plan, at `https://app.mcpjam.com/billing`: on a Free plan, upgrade to Pro (Free plans cannot buy credits); on a paid plan, buy credits.
2. Suggest BYOK (their own provider keys) to stop MCPJam inference charges. You cannot add the keys. BYOK does not remove platform fees.
3. Waiting for credits to reset is the last option, not the first.

Results the run completed before it stopped are saved. Do not relaunch on your own. If the user asks to relaunch a run you know stopped, use a new `--idempotency-key`: reusing the old key returns the stopped run instead of starting one. Never pay, upgrade, or buy credits yourself.

### Swarms goals

1. A goal needs a persona: `mcpjam cloud personas list --project <p>`, or `personas create --project <p> --name <n> --role <r> --notes <text> --idempotency-key <key>`. `personas generate` drafts candidates and saves nothing.
2. `mcpjam cloud goals create --project <p> --persona <id> --goal <text> --environment <id> --iterations <n> --max-turns <n>` authors a goal. `--iterations` and `--max-turns` are both required. Creating does not run it.
3. `mcpjam cloud goals get --goal-id <id>` shows how many conversations a run starts (targets × iterations), not a credit cost.
4. `mcpjam cloud goals run --project <p> --goal-id <id> --idempotency-key <key>` **spends** and returns immediately. Poll `goals status --project <p> --run <id>`.
5. Explain results from `goals scorecard --run <id>` first; it is deterministic and free. `goals findings` lists criteria that keep failing. `goals request-insights` uses a daily quota, so read the scorecard before asking for it.

### Studies

`mcpjam cloud studies publish --environment <id> --project <p>` publishes an environment and prints a share link; re-publishing returns the existing study. Read results with `studies metrics`, `studies findings`, and `studies sessions --study <id>`. `studies session` returns transcripts of real people, so prefer the aggregate reads unless the user asks for a conversation.

### Sandbox images

`images validate --file <blueprint.yaml>` lints without saving, then `images create`, then `images build` (asynchronous; poll `images logs`). `images use` and `images reset` rebuild the user's computer and wipe installed files; confirm first.

### Secrets

Values are write-only: no command prints one. Pass a value with `--value-file`, `--value-env`, or stdin, never as an inline argument that lands in shell history or a transcript. A rotation through `secrets update` reaches new runs only, and `secrets rm` does not revoke the credential at its provider.

## Spending and irreversible actions

Confirm with the user before the first of these in a conversation, naming the project and what it multiplies out to:

| Spends credits or daily quota | Changes or removes shared state |
|---|---|
| `cloud eval run`, `eval rerun`, `eval judge`, `eval judge-backtest`, `eval cases run` | `cloud projects delete`, `eval delete`, `clients delete`, `images delete`, `secrets rm`, `trace-destinations rm` |
| `cloud goals run` | `cloud studies rotate-link` (the old link stops working for everyone at once), `studies unpublish`, `studies guest-execution` |
| `cloud sessions send` (every turn is a model call; `--tool-mode auto` can make the servers take real actions) | `cloud images use`, `images reset` (wipe the user's computer) |
| `goals request-insights`, `studies request-insights`, `personas generate`, `goals generate` (daily quotas) | `cloud tunnel` on an existing server name (repoints it), `trace-destinations backfill` (a large window is a lot of vendor ingest) |

- Pass `--idempotency-key` on every launch and create that takes one. Use a new key for each distinct launch or create, and reuse it while that operation's outcome is unknown: a timeout does not prove the launch failed, and a fresh key can start and bill a second run. A relaunch of a run you know stopped is a distinct launch and needs the user's go-ahead.
- Never launch in a loop or to poll. Poll the matching `status` command.
- `environments archive` is undone by `environments restore`. `goals archive` and `swarms archive` keep past runs readable but have no CLI restore, and deletes are permanent. Prefer the reversible option when the user only wants something out of the way.

## Errors

- Exit `2` and `3` mean the same on every `mcpjam cloud` command as in the `eval run --wait` table above, except `eval gate`, where `3` means the gate is incomplete (codes above).
- Missing credentials fail before any network call with login guidance. Ask the user to run `mcpjam cloud login`; it opens a browser and needs them.
- An internal error with a request ID ends with a suggested `mcpjam cloud feedback` command. That sends text to the MCPJam team outside the user's organization, so show it to the user and let them decide.

## Hard rules

- Never run `mcpjam cloud …` to test a server the user gave you by URL when a local command answers the question. Local commands reach it directly; Cloud commands act on the user's MCPJam projects.
- Never act on the automatically chosen project for a write, publish, or spend. Name it.
- Reuse the idempotency key while a launch outcome is unknown; retrying with it returns the run if one started, even when the lost response took the run ID with it. Use a new key only when the user asks to relaunch a run you know stopped.
- Never report a goal or eval failure from a single iteration without reading the scorecard or steps behind it.
- Never pass secret values as positional or inline arguments.
