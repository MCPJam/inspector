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
| `list_organizations` | List the organizations the caller belongs to — where project `organizationId`s come from. | — |
| `list_projects` | List the MCPJam projects the caller can access, most recently updated first. | — |
| `create_project` | Create an empty project in one of the caller's organizations. | — |
| `update_project` | Rename a project or change its description, icon or visibility. Never touches server configs. | — |
| `list_project_servers` | List the MCP servers saved in an MCPJam project. | — |
| `create_project_server` | Save a new MCP server in a project, including optional credentials. | — |
| `get_project_server` | Read one saved MCP server by project and server id. | — |
| `update_project_server` | Update saved MCP server metadata or rotate/clear credentials. | — |
| `delete_project_server` | Soft-delete a saved MCP server from a project. | — |
| `connect_project_server` | Connect an MCP server URL to a project: discover its auth, save it, and return a private authorization link when a person must finish in a browser. | — |
| `get_project_server_connection_status` | Check a connection request started by `connect_project_server`. | — |
| `cancel_project_server_connection` | Cancel a pending connection request, releasing the concurrent-connection slot it holds. | — |
| `diagnose_server` | Diagnose a saved MCP server's connection: probe the URL, connect, initialize, and report capabilities and what failed. | — |
| `list_server_tools` | List the tools a saved MCP server exposes: names, descriptions, and input schemas. | — |
| `call_server_tool` | Execute a tool on a saved MCP server and return its result. | — |
| `render_server_widget` | Call an MCP App tool and mount its `ui://` widget in real headless Chromium, then report whether it rendered, what it logged, what it was blocked from fetching, and the widget as an accessibility tree with addressable elements. Returns the tree by default and the screenshot only on request. Executes the tool. | — |
| `list_server_prompts` | List the prompts a saved MCP server exposes: names, descriptions, and arguments. | — |
| `get_server_prompt` | Render a prompt from a saved MCP server with the given arguments and return its messages. | — |
| `list_server_resources` | List the resources a saved MCP server exposes: uris, names, and mime types. | — |
| `read_server_resource` | Read one resource from a saved MCP server by uri and return its contents. | — |
| `list_server_skills` | List the Agent Skills a saved MCP server serves over the skills extension (SEP-2640), including ones MCPJam declines to load and why. | — |
| `get_server_skill` | Fetch one skill from a saved MCP server by uri, verified against its manifest digest, advertised frontmatter, and uri identity before any content is returned. | — |
| `read_server_skill_file` | Read one supporting file of a server-served skill, checked against that skill's own manifest for byte length and digest. | — |
| `check_host_compatibility` | Check whether a saved MCP server's tools and widgets work on each AI host (Claude, ChatGPT, Cursor, Copilot, Codex, Goose, Mistral, n8n, Perplexity, Cline). | — |
| `start_claude_readiness_run` | Grade a saved MCP server against Anthropic's connector-directory rules. Starts a durable run and returns its id; poll for the verdict. | — |
| `start_openai_readiness_run` | Grade a saved MCP server against OpenAI's app-directory rules. Requires an explicit submission mode; starts a durable run and returns its id. | — |
| `get_readiness_run` | Read one readiness run: whether it finished, what it graded, and whether the optional model pass ran. | — |
| `list_readiness_runs` | List a project's readiness runs, newest first, optionally narrowed to one publisher or server. | — |
| `cancel_readiness_run` | Stop a readiness run that is still going. | — |
| `get_readiness_report` | Read a finished readiness run's findings, ordered most-consequential-first and capped. | — |
| `start_conformance_run` | Run protocol/apps/tasks conformance on a saved HTTP server. Starts a durable run and returns its id; poll for the verdict. | — |
| `get_conformance_run` | Read one conformance run: whether it finished, the outcome, score, and pending count. | — |
| `list_conformance_runs` | List a project's conformance runs, newest first, optionally narrowed to one saved server. | — |
| `get_conformance_report` | Read a finished conformance run's failing checks, capped, with per-suite profile stamps. | — |
| `list_eval_suites` | List the eval suites saved in an MCPJam project, with latest-run summaries and pass-rate trends. | ✅ |
| `list_eval_suite_runs` | List recent runs of an eval suite, newest first, with status, pass/fail result, and summary counts. | ✅ |
| `run_eval_case` | Start an asynchronous run of ONE case in an existing eval suite — a persisted, fully-queryable run scoped to just that case (inspect it with get_eval_run / list_eval_run_iterations / get_eval_run_steps, same as a full run). | — |
| `run_eval_suite` | Start an asynchronous rerun of an existing eval suite, against one target or several. Fan-out is explicit: a suite with several attached targets refuses with TARGET_REQUIRED unless you name targets or pass allAttached, and each target is one PAID run. | — |
| `create_eval_suite` | Create a runnable eval suite from authored test cases. | — |
| `get_eval_suite` | Fetch one eval suite's full settings: environment (servers), execution config (model/system prompt/temperature), hosts, match options, checks, LLM-as-judge (resolved: enabled, model, autoRun, threshold), schedule. | — |
| `get_eval_run_disclosure` | What a suite run would disclose before you launch it: which models it calls and where they route, which LLM analyzers/judges can fire and where their evidence goes, capture/retention/region facts, and the subprocessors engaged. Keyed by the same target a launch selects — pass `environment` or `host` to disclose for that plan. Read-only, never launches or gates a run. | — |
| `update_eval_suite` | Edit an eval suite's settings: name, description, environment servers, execution config (model/system prompt/temperature), hosts, minimum accuracy, match options, checks, and LLM-as-judge (`autoRun` is what makes grading happen; `enabled` alone only makes the judge available). | — |
| `list_eval_suite_revisions` | List a suite's settings history, newest first: who committed each edit, which stored fields moved, the note they left, and how many runs were launched against it. | — |
| `delete_eval_suite` | Permanently delete an eval suite and all its cases and runs. | — |
| `set_eval_suite_schedule` | Enable or disable automatic scheduled runs for a suite, and set the interval. | — |
| `set_eval_suite_environments` | Attach project environments to an eval suite, replacing whatever it had. | — |
| `list_eval_cases` | List the test cases in an eval suite, with their ids and configuration. | — |
| `get_eval_case` | Fetch one eval test case's full definition. | — |
| `create_eval_case` | Add one test case to an eval suite. | — |
| `create_eval_cases` | Add several test cases to an eval suite in one call. | — |
| `update_eval_case` | Edit an eval test case. | — |
| `delete_eval_case` | Permanently delete one test case from an eval suite. | — |
| `generate_eval_cases` | AI-generate test cases from the suite's server tools and persist them into the suite. | — |
| `get_eval_run` | Get the status, pass/fail result, and summary counts of an eval run. | ✅ |
| `get_eval_run_stage_analytics` | Get one run's user-value chain funnel: per stage, how many trials it applied to, reached it, were measured there, passed, failed, and were excluded and why — overall and by intent, model and host. Counts only; a zero denominator means not measured, never 0. | — |
| `list_eval_suite_stage_analytics` | List a suite's chain funnels newest-first, one document per run — a trend series, never an aggregate. Partition on the parity fields before claiming a trend; runs that do not share them are separate observations. | — |
| `compare_eval_run` | Compare an eval run against a baseline run: per-case status (regressed, fixed, new, removed, changed), per-scorer pass-rate and mean deltas from the evaluation contract, and whether the evaluation config changed. | — |
| `get_eval_gate_waiver` | Read the audited override in force over an eval run's release gate — who granted it, why, and until when — or null. Available to anyone who can view the run. | — |
| `list_eval_run_iterations` | List per-iteration results for an eval run: pass/fail, expected vs actual tool calls, token usage, and latency. | ✅ |
| `get_eval_iteration_trace` | Fetch the full trace for one eval iteration: the complete message history plus expected-vs-actual tool-call analysis. | — |
| `get_eval_run_steps` | Fetch one row per authored test step for an eval iteration, in order: each step's status (ok / fail / skipped / pending), the reason, and evidence (screenshot/video URLs, widget tool calls). | — |
| `cancel_eval_run` | Cancel an in-flight eval run. | — |
| `request_eval_run_judge` | Run LLM-as-judge grading over a finished eval run: each case's final answer is scored against its expected output. SPENDS the organization's model budget; read the results from `get_eval_run`'s `judges.goalCompletion`. | — |
| `list_eval_check_repos` | List the repositories whose pull requests run an eval suite, plus the repositories the MCPJam GitHub App can reach. | — |
| `connect_eval_check_repo` | Connect a repository so every pull request to it runs one eval suite and reports a GitHub check. | — |
| `list_project_environments` | List the project environments in an MCPJam project. | — |
| `get_project_environment` | Show one project environment: its host, optional standalone server group, pinned skill selection, pinned plugin versions, and its current `revision` (which you pass as `expectedRevision` when updating it). | — |
| `resolve_project_environment` | Resolve a project environment to the exact execution inputs a run would use right now: the host's current config, the closed server set (including servers contributed by pinned plugin versions), and the resolved plugin versions. | — |
| `ensure_adhoc_environment` | Get or create an unnamed, content-addressed environment for a composed stack (host plus optional model, sandbox image, server group, and pinned skills). Repeating the same stack reuses one row. Promote it with `name_environment` only when the user asks to keep it. | — |
| `list_sandbox_images` | List the custom Computer sandbox images (blueprints) in a project — the choices for a suite's `environment.computerEnvironment`. | — |
| `get_sandbox_image` | Show one sandbox image's blueprint, sharing, and latest build status. | — |
| `list_project_plugins` | List the live Agent Plugins installed in a project: name, display name, enabled state, and active version id. | — |
| `get_plugin_version` | Show one imported plugin version: status, component counts, and per-component summaries (servers with placement and auth timing, skills with their namespaced refs). | — |
| `list_project_skills` | List the Cloud Skills visible to you in a project, with the IDs that environments and eval runs pin. Each row reports whether it is eligible to be pinned, and why not if it isn't. | — |
| `get_project_skill` | Show one Cloud Skill including its SKILL.md body. | — |
| `list_scenarios` | List the scenarios published from an MCPJam project: name, access mode, attached servers, and share link. | ✅ |
| `get_scenario` | Get one scenario's read-only settings: model, system prompt, temperature, tool-approval policy, and resolved servers. | ✅ |
| `list_chat_sessions` | List chat sessions visible to the caller, most recent activity first. | — |
| `search_sessions` | Search a project's sessions across every surface (Playground, user testing, evals, swarms), ranked by relevance. `scope=titles` searches titles and opening messages; `scope=transcripts` searches what was said. Every result carries a link. | — |
| `send_chat_message` | Send one message to a project's MCP servers and get the reply plus the raw tool calls, per-call latency and token usage. SPENDS model credits. Pass the returned `sessionId` back to continue. Tools default to `read_only`; `toolMode=auto` may cause real side effects. `idempotencyKey` is required and must be stable across retries. | — |
| `get_chat_session` | Read a session's metadata and a window of its raw messages, indexed by absolute transcript position — the same indices the trace spans reference. | — |
| `get_chat_session_trace` | Read a session's per-turn spans: tool latency, token usage, transcript indices. Returns the latest turn by default; page older turns with `afterPromptIndex`, or pass `includeSpans=false` for summaries. | — |
| `get_capabilities` | Your role, which betas this organization has, your plan's limits, and a `can` block of booleans. Ask this before planning work that authors, launches or publishes — the tool list is the same for every caller and cannot tell you a beta is off. | — |
| `list_personas` | List the project's reusable synthetic characters — the cast Swarms journeys run as. | — |
| `get_persona` | Get one persona in full, including its behavioural notes. | — |
| `create_persona` | Create a reusable synthetic character for Swarms to run as. | — |
| `update_persona` | Edit a persona's name, role or notes. Finished runs keep the persona they ran as. | — |
| `delete_persona` | Remove a persona from the roster. Soft: history keeps resolving it. | — |
| `list_secrets` | List the project's credentials as metadata only — name, delivery mode, host binding, sharing. No value is ever returned. | — |
| `get_secret` | One secret's metadata: how it is delivered, where it is bound, when it was last handed to a run. Never its value. | — |
| `delete_secret` | Delete a stored credential. Hard: the row and the encrypted value both go, and delivery stops. Does not revoke the key at its provider. | — |
| `generate_personas` | Draft candidate personas with a model, grounded in what the project's servers do. Saves nothing; spends. | — |
| `list_journeys` | List the project's journeys — a persona, a goal, and the environments to pursue it against. | — |
| `get_journey` | Get one journey in full, including the execution config that determines how many sessions a run produces. | — |
| `create_journey` | Author a journey. Creating does not run it. | — |
| `update_journey` | Edit a journey. A run already in flight keeps the config it launched with. | — |
| `archive_journey` | Take a journey off the roster. Its runs, sessions and scorecards stay readable. | — |
| `generate_journeys` | Draft candidate journeys for a persona with a model. Saves nothing; spends. | — |
| `list_journey_runs` | List a journey's runs, newest first. | — |
| `get_journey_run` | Get one journey run: status, per-target rollups, and per-session attempt records. This is what to poll after launching. | — |
| `list_journey_run_sessions` | List the chat sessions a journey run produced, with readiness, goal scores and a first-message preview. | — |
| `launch_journey_run` | Launch a journey run and return immediately with its id. Spends model credits across the whole fan-out; pass an idempotency key. | — |
| `cancel_journey_run` | Stop a running journey run, settling its in-flight and pending sessions. | — |
| `list_swarms` | List swarm containers — the groups journeys are authored under, holding their shared execution config. | — |
| `get_swarm` | Get one swarm container: its name, defaults and fan-out. | — |
| `create_swarm` | Create a container to author journeys under. Runs nothing. | — |
| `update_swarm` | Edit a swarm container's name, description, fan-out or config. | — |
| `archive_swarm` | Take a swarm container off the roster. Journeys authored under it keep working. | — |
| `get_swarms_overview` | The project's recent runs with their rubric findings and goal-completion trend — the roll-up a human sees on the Swarms page. | — |
| `get_journey_run_scorecard` | Per-criterion pass/fail counts for one run. Deterministic, so read this first when explaining a failure. | — |
| `list_swarm_findings` | Criteria that keep failing across waves, with how long each has been failing. | — |
| `dismiss_swarm_finding` | Mark a finding as not worth acting on. Its lifecycle keeps updating underneath. | — |
| `undismiss_swarm_finding` | Bring a dismissed finding back into the active list. | — |
| `get_wave_insights` | The model's analysis of a whole wave, if one has been requested. Poll after requesting. | — |
| `request_wave_insights` | Ask a model to analyze a whole wave. Spends against the organization's shared daily insights budget. | — |
| `cancel_wave_insights` | Stop an in-flight insights generation — the recovery path for a wave stuck pending. | — |
| `publish_scenario` | Publish a project environment for user testing, returning its share link and access mode. | — |
| `unpublish_scenario` | Take a live user-testing scenario down. Every guest session on it dies with it. | — |
| `get_user_testing_scenario` | Scenario detail plus its actionable-insights envelope — aggregated findings with exemplar evidence over the latest analyzed window. | — |
| `list_user_testing_sessions` | Sessions real visitors had with a published scenario: counts, feedback, device, segment and a first-message preview. Summaries only. | — |
| `get_user_testing_session` | One session's conversation, paged and projected. Prefer the metrics or findings when you need the pattern rather than the words. | — |
| `get_user_testing_metrics` | Aggregate metrics across a scenario's sessions. | — |
| `get_user_testing_usage` | Usage rates by visitor and device. Read `scan.truncated` before quoting any rate. | — |
| `list_user_testing_findings` | Problems detected across a scenario's sessions, tracked over time. | — |
| `get_user_testing_signals` | The scenario's live analysis window, and the windowId its insights are keyed by. | — |
| `get_user_testing_insights` | The model's analysis of one analysis window, if one has been requested. | — |
| `update_user_testing_scenario` | Rename a scenario, or change who may open its share link. Send `mode` on its own — identity and exposure are separate operations. | — |
| `request_user_testing_insights` | Ask a model to analyze the current window. Spends against the organization's shared daily insights budget. | — |
| `cancel_user_testing_insights` | Stop an in-flight insights generation — the recovery path for a window stuck pending. | — |
| `dismiss_user_testing_finding` | Mark a finding as not worth acting on. | — |
| `undismiss_user_testing_finding` | Bring a dismissed finding back into the active list. | — |
| `set_user_testing_guest_execution` | What anonymous visitors may run on the organization's account, and how much. A full replacement, not a patch. | — |
| `rotate_user_testing_link` | Mint a new share link and invalidate the old one. Immediate and irreversible. | — |
| `upsert_user_testing_member` | Grant one person access to a scenario by email. | — |
| `remove_user_testing_member` | Revoke one person's access. | — |
| `rebind_user_testing_scenario` | Swap the environment behind a scenario, keeping its link, members and history. | — |
| `list_clients` | List a project's clients — the named, reusable configurations that define how MCPJam connects to and talks to your MCP servers. Returns each client's `configId`, the token every write takes. | — |
| `get_client` | One client's full settings: resolved config, `configId` (echo it back as `expectedConfigId`), and `impact` — what a config edit would follow. The first step of every edit. | — |
| `create_client` | Create a client from a built-in template or a full config. Additive: nothing that exists changes. | — |
| `update_client` | Edit a client's name and/or config. `set` changes named fields, `config` replaces everything. Requires `expectedConfigId` for a config edit and `expectedName` for a rename. | — |
| `set_client_servers` | Replace a client's required and optional server attachments. A REPLACEMENT — omitted servers are detached. Requires `expectedConfigId`. | — |
| `duplicate_client` | Create a new client carrying the selected client's current config. The source is untouched. | — |
| `search_registry_directory` | Search scraped MCP directories (Claude, ChatGPT, and any future source). `source` is a free string; omit it or pass `all` to search every source. | — |
| `get_registry_directory_server` | Fetch one scraped directory row by catalogServerId, or by name (optionally with source). | — |
| `list_registry_directory_sources` | Discover directory source ids for `search_registry_directory`. Sources are data, not an enum. | — |
| `list_registry_servers` | List global curated cards and the project's organization registry cards. | — |
| `list_registry_connections` | List directory and card installs already in a project (provenance rows whose server still exists). | — |
| `install_registry_directory_server` | Install writes a project `servers` row and provenance and stops — it is not a live connection. | — |
| `install_registry_server` | Install a curated registry card into a project. Writes a `servers` row and provenance; not a live connection. | — |
| `uninstall_registry_server` | Remove a curated or org registry-card install from a project. Directory uninstall is `delete_project_server`. | — |

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
with several refuses with `TARGET_REQUIRED` and names every candidate, rather
than guessing how much to spend. `run_eval_suite` also takes `environments`
(several, one paid run each), `host`/`hosts` for a suite with attached hosts,
and `allAttached` to fan out across every attached target on ONE axis —
environments if the suite has any, otherwise hosts, never a cross product.
`environment` and `servers` are mutually exclusive — an environment supplies a
closed server set that an override cannot change — and so are the environment
and host axes.

Instead of NAMING a target, `compose` builds one (or several): a host plus
optional models, sandbox image, server group and pinned skills becomes
unnamed, content-addressed environment cells (the same rows
`ensure_adhoc_environment` returns). Default is ephemeral — the cells are
minted and launched without attaching them to the suite. Pass `saveTargets`
to append them. `models` replaces the client default; add
`includeClientDefault` to keep the inherit cell alongside the explicit
picks. Promote such a row to a named environment in place with
`name_environment`.

An environment-backed run records the environment and the exact revision it
executed against, and `get_eval_run` reports that triple — so an agent can
confirm *which* configuration produced a result long after the environment has
been edited. A run that used a saved server selection has no environment to
record, and reports `environment: null`.

`ensure_adhoc_environment` is the one environment WRITE on this surface: it
mints a content-addressed, unnamed row (the same row `run_eval_suite`'s
`compose` produces). Creating, renaming, editing, and archiving named
environments stays CLI-only for now: those writes are revision-guarded
(`expectedRevision`), and giving an agent a safe path through optimistic
concurrency is a separate design question.

## Skills over MCP (SEP-2640)

This worker serves MCPJam's own Agent Skills alongside its tools, so an agent that connects gets the tools **and** the how-to knowledge for them without a separate install step. It declares:

```json
{ "capabilities": { "extensions": { "io.modelcontextprotocol/skills": {} } } }
```

and implements `skills/list`, `skills/get`, and `resources/read` for every URI in a skill's manifest. `resources/directory/read` is **not** implemented, so `directoryRead` is not declared — the manifest already enumerates every file.

The catalog is `run-mcpjam-evals`, `mcpjam-eval-import`, `create-mcp-eval`, and `explore-to-sdk-evals`. Only the first teaches this server's *tools* — the eval-run loop, what bills, and how to triage a failure. The other three teach authoring the eval files and suites those tools then operate on, which is the adjacency that matters for a caller working on evals. `mcp-inspector` is excluded because its subject is interpreting probe / doctor / OAuth / conformance output, and this server exposes none of those tools. `mcpjam-eval-import` is served by both venues deliberately: it spans them, producing a suite the platform tools run.

**The bundle is generated and committed.** `scripts/generate-skills-bundle.mjs` reads the SKILL.md sources, computes SHA-256 digests and byte sizes, and writes `src/generated/SkillsBundle.generated.ts`. After editing a skill, run `npm run bundle:skills -w @mcpjam/mcp` and commit the result; `tests/skillsBundleDrift.test.ts` fails if you forget. The generator is not a build hook because `build:ui` and `deploy` do not build `@mcpjam/sdk`, which it imports on purpose — it must parse frontmatter with the same function a host re-parses with, or we manufacture our own `frontmatter_drift`.

The generator refuses to emit anything MCPJam's own host would refuse: it runs `checkSkillIdentity`, enforces the draft's 512-entry / 16 MiB per-skill limits, and fails the build rather than warning.

### Two behaviours worth knowing

**Unknown `skill://` reads answer `-32602`, not `-32002`.** Both era codecs rewrite `ResourceNotFoundError` to Invalid params, so this worker cannot emit `-32002` even deliberately. That is what `isSkillNotFoundError` looks for anyway, but it differs from `sdk/tests/support/skills-fixture.ts`, which serves `-32002`.

**The extension is always advertised.** The worker is stateless, so the declaration cannot be gated on the client's own `extensions`. This is correct — SEP-2133 negotiates connection-level and the client half of the gate is the client's to enforce — but it is the same shape of deviation documented at the top of `src/tools/sessionToolRegistrar.ts`.

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
