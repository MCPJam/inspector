# UI-only agent chat — accomplishments & next steps

_Last updated: 2026-07-18_

## What this is

The in-app agent chat (Home "Ask anything" box + side panel) now **acts only by driving the
inspector UI**, so every action is visible to the user in their own app instead of happening
invisibly through backend tools. The user chats; the agent navigates, adds/connects servers,
runs tools in the playground, and observes app state — all through the `ui_*` WebMCP catalog.

## Status: all 6 PRs merged; both review rounds addressed; core loop proven in hosted

### The six PRs (merged, in stack order)

| PR | What it did |
|----|-------------|
| **#3262** `feat/ui-tool-annotations` | MCP `ToolAnnotations` on `ui_*` tools → **destructive-only approval** (nothing confirms by default except genuinely destructive actions; `ui_execute_tool` and `ui_remove_server` still confirm). |
| **#3263** `feat/agent-ui-only` | Dropped the platform MCP server from the agent chat turn; the agent acts via `ui_*` only, knows via docs + `web_search`. Static identity prompt. `MCPJAM_AGENT_PLATFORM_TOOLS=1` rolls back the whole prior contract. |
| **#3264** `feat/app-surface-manifests` | Per-screen **surface manifests** as the single source of truth → derived nav targets, the model-facing **app atlas** in the system prompt, and CI coverage tests that fail if a new screen ships agent-invisible. |
| **#3265** `feat/ui-context-per-turn` | Per-turn **orientation block** (route + selected servers) prepended as the user message's first part (`parts[0]`); conversation history stays append-only and user text is never rewritten — the agent always knows where the user is, **without breaking prompt caching**. |
| **#3266** `feat/app-snapshot-providers` | `ui_snapshot_app` observes **any screen**, not just the playground, via a per-surface provider registry + one app-level handler. |
| **#3267** `feat/connect-ui-tools` | Five Connect-screen tools: `ui_open_server_form`, `ui_add_server`, `ui_connect_server`, `ui_disconnect_server`, `ui_remove_server`. Catalog total: 12 tools (test-locked). |

### Key design decisions (kept deliberately)

- **Agent surfaces only** — the Playground chat (the most-used feature: testing a real MCP
  server against a model) is untouched.
- **No approvals by default, except destructive** — driven by MCP annotations, not a global
  toggle. A tool whose `annotations` object omits `destructiveHint` fails *safe* (reads as
  destructive → confirms). Caveat: an entry with **no annotations object at all** keeps the
  legacy flag-gated semantics on purpose (old-client snapshots must not change gating) — so
  new catalog tools must always ship a complete annotations object.
- **Add and connect are separate, visible steps** — `ui_add_server` saves without connecting;
  `ui_connect_server` connects and reports the outcome. If a server needs OAuth, the tool
  reports `authorization_required` and leaves the Authorize click to the user — it never
  redirects mid-call. (Consent stays the human's to give.)
- **No credentials in the chat transcript** — the server draft can't carry env/headers (they
  routinely hold secrets); those get entered in the form by the user.
- **Mutation tools navigate to Connect first** — so the user watches the change land on-screen.
- **Cache-safe prompt shape** — static app atlas in the cacheable prefix; volatile per-turn
  state appended after. (Caching itself is not yet enabled — see next steps.)
- **Dropped `ui_reconnect_server` / `ui_test_connection`** — they overlapped `ui_connect_server`,
  and overlapping tools confuse the agent (Chrome WebMCP guidance).

### Review (two rounds, all findings addressed)

- **Round 1** fixed three serious bugs in #3262 alone: a turn-**stranding** hole (denying a
  destructive tool with the flag off was never processed), a **fail-open** annotation
  contradiction, and a **spoofable-name** security exemption. Plus #3267's credentials/billing/
  visibility issues, #3266's Evals-panel snapshot shadowing, and #3265's user-text deletion.
- **Round 2** fixed a server-side type hole, the `"none"` selected-server sentinel leaking as a
  real server, #3266's serialization-work bound + error-code correctness + invalid-surface
  handling, and #3267's app-readiness guard (agent add couldn't run during project provisioning).

### Hosted QA — core loop exercised live (no evidence captured yet)

> ⚠️ The runs below were ad hoc: no trace links, session recordings, or screenshots were
> retained. Treat them as anecdotes until Workstream 1 of
> [UI_ONLY_CHAT_IMPLEMENTATION.md](./UI_ONLY_CHAT_IMPLEMENTATION.md) captures evidence.

- **Drive:** "connect to `https://mcp.excalidraw.com/mcp`" → `ui_add_server` → `ui_connect_server`
  → Excalidraw shows **Connected** on the Connect screen. Add/connect ran without a confirmation
  pill (correct — both are non-destructive).
- **Observe:** "what other servers are here" → `ui_snapshot_app` → correctly listed all three
  servers with live connection status.

## Next steps — recommended handoff order

> **Implementation plan:** each step below is expanded into an implementable workstream —
> with the feature-flag design for the `ui_*` surface — in
> [UI_ONLY_CHAT_IMPLEMENTATION.md](./UI_ONLY_CHAT_IMPLEMENTATION.md).

### 1. Complete hosted QA and capture evidence (release-confidence gate)

- [ ] **OAuth `authorization_required` and recovery** — ask the agent to connect a server that
      needs interactive OAuth (Linear / Notion are available and disconnected). Confirm the tool
      reports that authorization is required, does not redirect mid-call, and leaves the server
      visibly pending. After the user clicks Authorize, confirm a follow-up turn can observe the
      connected state and continue.
- [ ] **Destructive approval: approve and deny** — with global tool approval off, exercise both
      `ui_remove_server` (using a disposable server) and `ui_execute_tool` (using a harmless tool).
      Confirm both show a confirmation pill. Test one approval and one denial, and verify a denial
      resumes the same turn instead of stranding it or retrying automatically.
- [ ] **Full chain through execution** — complete one disposable end-to-end flow:
      navigate → add → connect → open Playground → select a harmless tool → execute → observe the
      result. The execution step should confirm; add/connect should not.
- [ ] **Entry-point and policy matrix** — smoke-test the Home "Ask anything" box and the side
      panel, first with the default destructive-only policy and then with strict tool approval on.
- [ ] **Rollback smoke test** — enable `MCPJAM_AGENT_PLATFORM_TOOLS=1` in a non-production
      environment and verify the prior platform-tools contract still works.

**Exit criterion:** retain a trace or session link for each scenario, file any failures, and do
not expand the tool catalog while a correctness or safety failure remains open.

### 2. Instrument outcomes and cache telemetry

Land this before enabling caching or choosing the next surface.

- [ ] **Preserve cache usage end to end** — extend the shared/live trace usage shape beyond
      input/output/total tokens to carry cache-read, cache-write, and non-cached input tokens.
      Preserve the fields through both execution engines: direct AI SDK `streamText` and the
      hosted Convex `/stream` / `/stream/org` path.
- [ ] **Record UI-tool outcomes** — for every `ui_*` attempt and completion, capture the tool name,
      current surface/route, duration, result/error code, whether approval was requested, and the
      approval outcome. Do not log raw arguments, outputs, headers, env, or other possible secrets.
- [ ] **Detect duplicate work** — attach a safe call signature so repeated read-only calls such as
      the observed double `ui_snapshot_app` can be measured before changing prompts or behavior.
- [ ] **Define capability-gap telemetry** — "the agent wanted an unavailable action" is not
      directly observable. Start with a post-turn classifier/sampled review for action-oriented
      user turns where no matching `ui_*` tool ran and the answer reported a limitation. Keep the
      classifier out of the model-facing tool catalog unless the passive signal proves too noisy.
- [ ] **Create a baseline view** — track task completion, tool error rate, approval/denial rate,
      duplicate-call rate, capability-gap volume, and p50/p95 turn latency by model and provider.

**Exit criterion:** collect a clean baseline long enough to distinguish one-off QA behavior from
recurring product demand before interpreting the numbers.

### 3. Run a provider-aware prompt-caching canary

The prompt is already shaped correctly: the static app atlas is in the stable prefix and volatile
route/selection context is appended per turn. The activation mechanism is provider-specific:

- **OpenAI:** prompt caching is automatic for eligible requests. Preserve the stable prefix and
  measure cache reads first; add a provider-specific cache key only if the data shows it is needed.
- **Anthropic:** add an AI SDK cache breakpoint using
  `providerOptions.anthropic.cacheControl` at the end of the stable prefix. Do not inject raw
  `cache_control` into every provider request.
- **Other/custom providers:** leave unchanged until their caching contract is documented and
  verified.

- [ ] Thread provider-specific cache options through both the direct `streamText` path and the
      hosted Convex request contract; do not validate only the easier local/BYOK path.
- [ ] Gate the change behind a rollout flag and attach a stable-prefix fingerprint plus model,
      provider, and execution-path dimensions to the telemetry.
- [ ] Test a cold first turn, warm second turn, and a multi-step tool-calling turn. Verify positive
      cache-read usage on a supported model and eligible prompt, unchanged agent behavior, and an
      improvement in latency and/or input cost. A zero hit should trigger prefix/fingerprint and
      provider-path debugging rather than an assumption that caching is active.

**Exit criterion:** expand the canary only after cache metrics are visible on every supported
execution path and no quality or tool-calling regression appears.

### 4. Expand the catalog from observed demand

The manifest + command-bus pattern is proven on Connect. Use the capability-gap and failure data
to rank missing actions; do not pre-commit to Evals, Registry, or Debuggers solely by surface size.

- [ ] Pick one high-volume workflow and implement it end to end: manifest coverage, snapshot
      provider, visible command handlers, precise annotations, error semantics, and tests.
- [ ] Re-check the ranking after each addition rather than shipping a large speculative batch.
- [ ] Promote target-tool annotation pass-through for `ui_execute_tool` if approval telemetry shows
      meaningful abandonment or repeated friction; otherwise keep its conservative confirmation.

### 5. Deferred (hold until data justifies)

- Generic `read_screen` / `click(ref)` fallback for uncovered UI (the computer-use hybrid).
- ⌘K command palette over the same command bus (humans + agent share one registry).
- Design-system `agent` affordance prop so new features get chat coverage by default.

## Minor observations (low priority)

- In the "what other servers are here" flow, the agent called `ui_snapshot_app` **twice** before
  answering. Harmless, but worth a glance — may be the model double-calling, or snapshotting a
  surface then the whole app. Not blocking.

## Rollback

`MCPJAM_AGENT_PLATFORM_TOOLS=1` restores the complete prior agent-chat contract (platform
server + preflight + workspace prompt) — a full rollback, not a half one.
