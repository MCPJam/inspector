# UI-only agent chat — implementation plan

_Last updated: 2026-07-18. Targets `main` after PRs #3262–#3267 (all merged 2026-07-17)._

This is the implementation companion to [UI_ONLY_CHAT_SUMMARY.md](./UI_ONLY_CHAT_SUMMARY.md).
It turns that document's next-steps roadmap into implementable workstreams — hosted QA
evidence capture, outcome + cache telemetry, a provider-aware prompt-caching canary, and
catalog expansion — with the feature-flag design for the WebMCP `ui_*` surface built into
each workstream rather than bolted on afterward.

All file paths are relative to the app package `mcpjam-inspector/` inside the repo, and
all line references were verified against `main` at the time of writing.

## §0 Scope and corrections carried forward

Corrections to the summary doc, established by a code audit against `main` (2026-07-17):

- The catalog is exactly **12** `ui_*` tools, not ~14. The set is test-locked in
  `client/src/lib/webmcp/__tests__/ui-tools-catalog.test.ts:42-65`.
- "An unannotated future tool fails safe" holds only for a tool whose `annotations`
  object *omits* `destructiveHint`. An entry with **no annotations object at all**
  deliberately keeps legacy flag-gated semantics
  (`shared/client-fulfilled-tools.ts:95-96`) so old-client snapshots don't change gating
  behavior. Do not describe fully-annotationless entries as fail-safe.
- The per-turn orientation block is **prepended** as `parts[0]` of the user message
  (`client/src/hooks/use-mcpjam-agent-session.ts:361`). The cache-relevant property —
  history is append-only, user text is never rewritten — holds; the position is before
  the text, not after.
- The summary's "core loop verified live" hosted QA has **no captured evidence**.
  Workstream 1 exists to fix that.

## §1 Architecture seams (orientation)

Every workstream hooks into one or more of these six seams:

1. **Registration** — `useRegisterUiTools({ enabled })`
   (`client/src/lib/webmcp/use-register-ui-tools.ts`), mounted once with
   `enabled: !isChatboxChatRoute` (`client/src/App.tsx:2051`). The only existing
   registration conditionality, and it is all-or-nothing for the whole catalog.
2. **Registry + snapshot** — `client/src/lib/webmcp/ui-tools-registry.ts`.
   `registerUiTool(def, { signal })` supports hang-safe dynamic unregister; the
   never-evicted `shippedNames` set lets an in-flight stream error (not hang) on a tool
   unregistered mid-turn. `snapshotForChatBody()` ships the **full currently-registered
   set on every POST** (64-entry cap, 512-char descriptions, 8 KB schemas) — it is not a
   diff, so a tool registered late simply appears in the next POST.
3. **Native mirror** — `client/src/lib/webmcp/native-mirror.ts`, the only file allowed
   to touch `document.modelContext`. Register/unregister propagates 1:1 automatically
   via per-tool disposers.
4. **Manifests → atlas → nav** — `shared/app-surfaces.ts` (`APP_SURFACES`) is the single
   source of truth. `buildAppAtlas({ hosted })` (`:503-506`) is called once per process
   into the static `AGENT_IDENTITY_PROMPT` (`server/routes/web/mcpjam-agent.ts:133`);
   `listAppSurfaceNavSegments()` (`:488`) derives nav targets, enforced client-side by
   `resolveUiNavigationTarget` (`client/src/lib/webmcp/ui-actions.ts:110`).
5. **Chat-body path** — client POSTs `uiTools` → `validateUiToolEntries`
   (`server/utils/chat-v2-orchestration.ts:331`, shape/caps only) → `buildUiTools`
   (`:756`, no-execute AI SDK tools) + `buildUiToolsSystemPrompt` (`:780`).
6. **Engines** — the agent route uses the same `streamWebChatTurn` dispatcher as
   playground chat (`server/utils/web-chat-turn.ts`): local BYOK direct `streamText`
   (`:518-544`; the call itself is `server/utils/direct-chat-turn.ts:680-691`), hosted
   org BYOK `/stream/org` (`:547-579`), MCPJam-provided `/stream` (`:608-644`). The
   hosted request body (`server/utils/mcpjam-stream-handler.ts:2076-2103`) is extended
   via `extraBodyFields`.

**Hard constraints (do not violate in any workstream):**

- The atlas is cache-static per process — test-locked
  (`client/src/lib/__tests__/app-surface-coverage.test.ts:162-164` determinism,
  `:166-169` 12k-char cap). Nothing per-request or per-user may enter it.
- `uiToolCallNeedsApproval` (`shared/client-fulfilled-tools.ts:89-111`) is the single
  source of truth for both sides of the approval handshake; client and server must
  agree mid-turn.
- Dispatch gates on registry membership (`resolve`), never on the `ui_` prefix.
- Catalog registration is deliberately global, not contextual (rationale in the
  `ui-tools-catalog.ts` header); scoped registration exists for when a tool group
  genuinely needs it.
- `native-mirror.ts` is the only native-API touchpoint.

## §2 Feature-flag architecture for the WebMCP surface

There is no flag story today: the agent chat is entirely unflagged (side panel mounted
unconditionally at `App.tsx:3816`, Home hero unflagged), the server never reads PostHog
(`server/utils/analytics.ts:32` — posthog-node can only ingest), and a PostHog-flagged-off
screen is still fully visible and reachable by the agent. Three layers fix this; only the
first is being implemented now (PR F-1 — see §7), the second is specified for the
first catalog expansion, the third already exists.

### Layer 1 — `agent-chat-enabled`: one PostHog kill switch (PR F-1)

Gates exactly three call sites:

| Site | Location | Off behavior |
|---|---|---|
| Home "Ask anything" hero | `client/src/components/HomeTab.tsx` (McpjamAgentHero/Thread) | not rendered |
| Agent side panel | `AgentSidePanelMount` at `App.tsx:3816` | not rendered (⌘\ inert) |
| Tool registration | `useRegisterUiTools` composition at `App.tsx:2051` → `enabled: !isChatboxChatRoute && agentChatEnabled` | catalog unregistered, native mirror clean |

**Semantics: kill switch, fail-OPEN (`flag !== false`).** This deviates from the repo's
fail-closed convention (`useSkillsEnabled`'s `=== true`) deliberately:

- Fail-closed is correct for **pre-launch** surfaces. The agent chat is already launched
  and live in hosted; `=== true` would dark-ship it for everyone until the flag is
  created, and would cause register→unregister churn plus visible flicker on every cold
  load while `useFeatureFlagEnabled` returns `undefined` during flag hydration.
- With `!== false`: `undefined` (loading, or flag absent) ⇒ on, zero churn, the first
  POST's snapshot is complete; explicit `false` ⇒ off.

New hook `useAgentChatEnabled` in `client/src/hooks/`, documented head-to-head with
`useSkillsEnabled` so the two conventions don't blur:
**pre-launch surface = fail-closed `=== true`; post-launch kill switch = fail-open
`!== false`.**

Kill-flip mid-session rides existing machinery: the `useRegisterUiTools` cleanup aborts
its controller → all 12 tools unregister and native mirrors dispose; an in-flight stream
calling a `ui_*` tool errors instead of hanging (`shippedNames` + membership-gated
dispatch). No new teardown code.

**Ops:** create `agent-chat-enabled` in PostHog rolled out "on for all" *before* F-1
deploys. Absence already means on, but pre-creating removes ambiguity and makes the
switch one click when needed.

### Layer 2 — `agentToolsFlag`: per-surface tool-group axis (specify now, build with PR E-1)

For incremental catalog rollout: `agentToolsFlag?: string` on `AppSurfaceManifest`,
directly paralleling `hostedBlocked` (`shared/app-surfaces.ts:63`). Names a PostHog flag
(e.g. `evals-agent-tools`). Semantics: **fail-closed `=== true`** — these are genuinely
pre-launch tool groups. When not `true`:

- the surface's tool group never registers (and therefore never snapshots or mirrors),
- any nav segments the group introduces are rejected by `resolveUiNavigationTarget`,
- its snapshot providers stay silent.

**Not built before the first new tool group exists.** A dead axis with zero consumers
rots — the stale `playground-enabled` flag (referenced only by one test file today; the
Playground has no live gate) is the cautionary example. This section is the spec E-1
implements mechanically.

Late hydration is clean by construction: group tools are absent from POSTs until the
flag resolves `true`, then present in every subsequent POST (seam 2's full-set-per-POST
semantics). Cost: one turn of unavailability on a cold load for flagged-in users of a
pre-launch group — acceptable.

### Layer 3 — server env kill switches (exists; add nothing here)

`MCPJAM_AGENT_PLATFORM_TOOLS=1` (`server/routes/web/mcpjam-agent.ts:102-104`) remains the
deep rollback to the complete pre-UI-only contract. The caching canary gets its own env
gate (§5). No new server envs for tool groups — that would duplicate Layer 2 with worse
granularity.

### The atlas question

Per-user flags categorically cannot enter the atlas (hard constraint above). Two cases:

1. **Existing screen gaining agent tools** (the common case, e.g. Evals): no atlas
   change. The atlas describes what the screen *is*; `ui_navigate` and
   `ui_snapshot_app` already work there today. Flag off = agent can navigate and
   observe but not act — which is exactly current shipped behavior, not a locked door.
2. **New screen behind its own product flag**: ship with `showInAtlas: false` (a
   deploy-time value, consistent with atlas staticness) and flip to `true` in the GA
   deploy. The flagged-in minority is not blind: their per-turn `uiTools` snapshot is
   per-user by construction and the group's tool descriptions name their surface. The
   static atlas is the commons; the snapshot is the per-user capability channel. This
   also helps the 12k-char cap.

`ui_navigate`'s description embeds the target list at registration time; leave it
advisory. Enforcement lives in `resolveUiNavigationTarget`, which gains a distinct
`flag_off` rejection reason. Do not re-register `ui_navigate` on flag flips.

### Consistency contract: "flagged-off = agent-invisible"

For a tool group G gated by flag F (and, via Layer 1, the whole catalog):

| # | Invariant | Enforced by | Asserted by |
|---|---|---|---|
| I1 | No G tool in the registry ⇒ absent from every `snapshotForChatBody` | `useRegisterUiTools` group composition | hook flag-matrix test |
| I2 | No G tool in `document.modelContext` | 1:1 mirror disposers (follows I1) | registry abort/mirror test |
| I3 | G's nav segments rejected with reason `flag_off`; omitted from `listUiNavigationTargets` | `ui-actions.ts` resolver | resolver unit matrix |
| I4 | G's snapshot providers never register while F is off — even when the surface is mounted (a human can navigate there; I3 gates only the agent's path) | the group's provider opt-in (its `snapshotSurfaceId` wiring) is part of the flagged group and registers only when F is `true` | integration test: mount the surface with F off ⇒ provider absent from whole-app and per-surface reads |
| I5 | A NEW surface shipped behind its own product flag has `showInAtlas: false` until GA (atlas case 2). Existing surfaces gaining a flagged tool group keep `showInAtlas: true` — atlas case 1 applies, no contradiction | manifest data | policy test cloned from the `hostedBlocked` exact-match template (`app-surface-coverage.test.ts:133-138`), keyed on new-surface manifests only |
| I6 | Flip on→off mid-session: tools + mirrors gone; in-flight calls ERROR, never hang | AbortSignal + `shippedNames` | group-scoped abort test |
| I7 | Flip off→on mid-session: tools appear in the next POST | full-set snapshot semantics | register-after-snapshot test |
| I8 | Flags never touch `uiToolCallNeedsApproval`; approval parity is flag-independent | leave `shared/client-fulfilled-tools.ts` untouched | no-flag-import assertion + existing parity tests |

### Server-side stance: client-only enforcement

Threat model: PostHog flags are **product rollout, not security**. The principal is the
human user; `ui_*` tools execute in the user's own browser session under the user's own
authorization. A user who hand-edits the chat POST to include un-flagged `uiTools`
entries can only induce the model to emit tool calls their own client must fulfill — the
client won't (registry membership gate), and even manual fulfillment does nothing the
user couldn't do by clicking the UI. No privilege boundary is crossed.

Therefore the server keeps trusting the validated snapshot (shape/caps only). Do **not**
thread PostHog flag state per-turn through the request body — the
`progressiveToolDiscovery` override pattern exists for host-policy reconciliation, which
flags are not. Server gates remain env-only.

**Axis independence:** feature flags ⊥ billing gates (`billingFeature` /
`applyBillingGateNavState`, entitlement-driven) ⊥ auth (`isAuthenticated` AND-ing) ⊥
hosted (`HOSTED_MODE` / `hostedBlocked`). Never collapse them into one check.

## §3 Workstream 1 — Hosted QA evidence capture

Turns the summary's checklist into an evidence protocol. For each scenario record:
preconditions (env, flag/env state), the exact user prompt, expected observable behavior
(which tools fire, which show approval pills, terminal UI state), and retained
artifacts — **PostHog session-recording link + hosted trace/session id + screenshot** —
in an evidence table kept in `docs/qa/ui-only-chat/` (or appended here).

| # | Scenario | Key expectations |
|---|---|---|
| 1 | OAuth `authorization_required` + recovery (Linear/Notion) | connect reports authorization required; no mid-call redirect; server visibly pending; post-Authorize follow-up turn observes connected state |
| 2 | Destructive approve AND deny (global approval off) | `ui_remove_server` (disposable server) and `ui_execute_tool` (harmless tool) both pill; one approval, one denial; **denial resumes the same turn** — no strand, no auto-retry |
| 3 | Full chain | navigate → add → connect → open Playground → select harmless tool → execute → observe; execution pills, add/connect do not |
| 4 | Entry-point × policy matrix | Home hero and side panel, each under default (destructive-only) and strict approval |
| 5 | Rollback smoke | `MCPJAM_AGENT_PLATFORM_TOOLS=1` in non-prod restores the full prior platform-tools contract |
| 6 | *(post-F-1)* Kill-switch flip | `agent-chat-enabled=false` mid-session: hero + panel vanish, registry and native mirror empty, in-flight turn errors gracefully |

**Exit criterion** (unchanged from the summary): retain evidence per scenario, file
failures, and do not expand the tool catalog while any correctness or safety failure is
open.

## §4 Workstream 2 — Outcome + cache telemetry

Lands **before** the caching canary so a baseline exists.

### New events (typed registry `shared/analytics-events.ts`; snake_case; IDs/names/booleans/counts only — never message text, tool args, outputs, headers, or env)

| Event | Source | Emitted at | Dimensions |
|---|---|---|---|
| `ui_tool_call_started` | client | `ui-tool-executor.ts` (the one point where approval path + timing are known) | `tool_name`, `surface_id`, `entry_point` (`side_panel`\|`home_hero`), `needs_approval` |
| `ui_tool_call_completed` | client | same | `tool_name`, `surface_id`, `duration_ms`, `outcome` (`success`\|`error`\|`denied`), `error_code?`, `approval` (`not_required`\|`approved`\|`denied`), `duplicate_of_previous`, `calls_since_duplicate?` |
| `ui_navigation_rejected` | client | `ui-actions.ts` resolver | `segment`, `reason` (`unknown`\|`hosted_blocked`\|`flag_off`) — doubles as capability-demand and flag-friction signal |
| `agent_turn_completed` | client | stream finish | `model`, `provider`, `execution_path`, `ui_tool_call_count`, `distinct_tool_count`, `had_error`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `duration_ms` |
| `chat_turn_cache_usage_server` | server (`captureServerEvent`) | turn finish, both engines | `model`, `provider`, `execution_path` (`direct`\|`hosted_stream`\|`hosted_org`), `canary_enabled`, `prefix_fingerprint`, `input_tokens`, `cache_read_tokens`, `cache_write_tokens` |

No `_server` twins for the client events initially — twins are a migration/block-rate
device for established funnels, not a requirement for new events (and the `/relay` proxy
already mitigates ad-block loss). Revisit if funnel-grade fidelity is needed.

### Duplicate-call detection

Compute `signature = tool_name + canonicalJSON(args)` **client-side, in memory, per
session** in the executor; compare against recent calls; emit only
`duplicate_of_previous` + `calls_since_duplicate`. This deviates from the summary's
"attach a safe call signature" reading on purpose: hashes of low-entropy args (server
URLs, tool names) are dictionary-reversible, which strains the never-log-args rule;
booleans/counts measure the observed double-`ui_snapshot_app` just as well.

### Capability-gap detection

No live classifier, no new model-facing tool. SQL over `agent_turn_completed`
(`ui_tool_call_count = 0` on action-oriented turns) intersected with
`ui_navigation_rejected` volume, then sampled human review via hosted traces/session
recordings. The ranked output feeds §6's surface selection.

### Cache-usage field plumbing (prerequisite for §5)

Additive, zero behavior change:

1. `shared/live-chat-trace.ts` — `LiveChatTraceUsage` gains optional
   `cachedInputTokens?` and `cacheWriteTokens?`; `mergeLiveChatTraceUsage` (`:130-154`)
   sums them when present. Mirror the two fields on eval spans
   (`shared/eval-trace.ts:27-29`) and client `TokenUsage`
   (`client/src/hooks/use-chat-session.ts:304-308`).
2. Direct producer — `toLiveChatTraceUsage` (`server/utils/direct-chat-turn.ts:447-462`).
   The installed SDK is **ai v6**, where cache tokens are first-class on
   `LanguageModelUsage.inputTokenDetails`: read
   `inputTokenDetails.cacheReadTokens ?? cachedInputTokens` (the top-level field is a
   deprecated alias) for reads and `inputTokenDetails.cacheWriteTokens` for writes — no
   `providerMetadata` digging needed.
3. Hosted producer — `readUsageFromFinishChunk`
   (`server/utils/mcpjam-stream-handler.ts:830-866`) reads the same field shapes (flat
   wire names and `inputTokenDetails`) off the finish chunk.
4. BYOK writeback — `postLocalUsage` (`server/utils/org-model-stream-handler.ts:738-819`)
   forwards both fields.
5. UI — `client/src/components/chat-v2/chat-input.tsx:1759-1777` stops passing
   `undefined`: `cacheReadTokens: cachedInputTokens`, `cacheWriteTokens`,
   `noCacheTokens: inputTokens - cachedInputTokens`. The `<Context>` component already
   renders these; zero component work.

### Baseline dashboard

Task completion, tool error rate, approval/denial rate, duplicate-call rate,
nav-rejection volume, capability-gap volume, p50/p95 turn latency — by model, provider,
and execution path. **Exit criterion:** a baseline window long enough to separate
one-off QA behavior from recurring product demand before interpreting the numbers.

## §5 Workstream 3 — Provider-aware prompt-caching canary

The prompt is already cache-shaped (static atlas prefix, volatile context appended
per-turn). This workstream activates and *measures* caching without trusting it blindly.

### Mechanism

New shared helper (suggested `server/utils/prompt-cache.ts`):
`applyCacheBreakpoints({ provider, system, messages })`:

- **Anthropic** — one `providerOptions.anthropic.cacheControl: { type: "ephemeral" }`
  breakpoint at the end of the stable prefix (the `AGENT_IDENTITY_PROMPT` system
  content; safe because volatile orientation is appended after it, never inside).
  Never inject raw `cache_control` into every request.
- **OpenAI** — no-op; caching is automatic for eligible prompts. Measure first; add a
  provider cache key only if data shows it is needed.
- **Other/custom providers** — no-op until their caching contract is documented.

Wiring:

- **Direct engine** — add `providerOptions` to the `streamText` call at
  `direct-chat-turn.ts:680-691` (currently passes none; greenfield parameter).
- **Hosted engines** — the backend (separate repo) executes `streamText`; our lever is
  the request contract. Extend `extraBodyFields`
  (`mcpjam-stream-handler.ts:2076-2103`; precedent: `providerKey`, gateway attribution)
  with `promptCache: { mode: "anthropic-breakpoint" | "off" }`.
  **Cross-repo contract note:** the backend ignores unknown body fields today, so the
  inspector can emit the field before backend support lands (hosted paths simply show
  zero cache reads, visible per `execution_path`); backend support is an external-repo
  PR (C-2). Version the field by name, not position; never repurpose it.

### Rollout control

**Server env `MCPJAM_PROMPT_CACHE_CANARY` (`"1"`/`"true"`, `server/config.ts` pattern).**
Not PostHog — the server never reads PostHog, and a canary is a deployment experiment,
not a per-user rollout. Not request-body — no per-user variation is wanted, and
threading a client flag adds a trust surface for nothing. If a per-user ramp is ever
needed, the documented phase-2 path is client flag → request body with server override
(the `progressiveToolDiscovery` precedent) — specified, not built.

### Fingerprint and dimensions

`prefix_fingerprint` = hash of (`AGENT_IDENTITY_PROMPT` text + sorted validated uiTools
`name:description` pairs), computed server-side per turn (static part memoized per
process), attached to `chat_turn_cache_usage_server` along with model, provider,
`execution_path`, `canary_enabled`. A fingerprint that churns turn-to-turn **is** the
debugging signal for zero cache reads.

### Test matrix

- **Unit:** exactly one breakpoint, placed at the stable-prefix end, only for Anthropic,
  only when the env is on; env off ⇒ byte-identical `streamText` arguments.
- **Multi-step:** fingerprint constant across tool-calling steps within a turn;
  orientation-append-only regression (reuses #3265's tests).
- **Cold/warm (manual protocol — CI can't hit paid APIs):** cold turn shows
  `cache_write > 0, cache_read = 0`; warm second turn within TTL shows
  `cache_read > 0`; agent behavior unchanged; latency and/or input cost improved.
- **Zero-hit triage runbook:** check fingerprint stability first, provider/execution
  path second, provider eligibility (prompt length minimums) third. Never assume
  caching is active.

**Exit criterion:** expand only after cache metrics are visible on every supported
execution path and no quality or tool-calling regression appears.

## §6 Workstream 4 — Catalog expansion + the flag axis

The manifest + command-bus pattern is proven on Connect. Expansion is demand-ranked, not
surface-size-ranked:

1. Rank candidate workflows by `ui_navigation_rejected` volume + the capability-gap
   analysis (§4). Pick **one** high-volume workflow.
2. Implement it end to end behind an `agentToolsFlag` (Layer 2, first consumer):
   manifest coverage, snapshot provider, visible command handlers, precise annotations
   (every tool ships a complete `annotations` object — see §0 on the annotationless
   legacy branch), error semantics, tests.
3. Refactor shape: `buildUiToolsCatalog()` stays zero-arg and returns the shipped 12 —
   **the exact-12 test survives verbatim** as the GA-catalog guard. New groups live in
   `buildUiToolGroup(surfaceId)` functions with their own exact-list tests;
   `useRegisterUiTools` composes base + flag-enabled groups, one AbortController per
   group (I6/I7).
4. `resolveUiNavigationTarget` gains the `flag_off` rejection; the I5 policy test lands
   with the axis.
5. Re-rank after each addition; no speculative batches.
6. Promote `ui_execute_tool` target-tool annotation pass-through only if approval
   telemetry shows meaningful abandonment; otherwise keep its conservative confirmation.

Deferred until data justifies (unchanged from the summary): generic
`read_screen`/`click(ref)` fallback, ⌘K palette over the command bus, design-system
`agent` affordance prop.

## §7 PR decomposition and sequencing

| PR | Content | Depends on | Size |
|---|---|---|---|
| **F-1** | `useAgentChatEnabled` kill-switch hook + three gate sites + flag-matrix tests | — | S |
| **T-1** | Cache-usage fields end-to-end (type, both producers, `postLocalUsage`, `TokenUsage`, `<Context>` UI). Zero behavior change; captures OpenAI automatic-cache baseline for free | — | M |
| **T-2** | `ui_*` outcome events in the executor + `ui_navigation_rejected` + `agent_turn_completed` + registry/ratchet entries + duplicate detection | — | M |
| **T-3** | `chat_turn_cache_usage_server` + prefix fingerprint (server) | T-1 | S |
| **C-1** | Cache helper + direct-path `providerOptions` + `MCPJAM_PROMPT_CACHE_CANARY` + hosted `promptCache` emission + unit/multi-step tests + manual protocol | T-1, T-3 | M |
| **C-2** | Hosted backend honors `promptCache` | C-1 contract | ext. repo |
| **E-1** | `agentToolsFlag` axis + group refactor + `flag_off` rejection + first tool group + I5 test | T-2 baseline, QA exit | L |
| **QA-1** | Evidence capture execution + evidence table (docs-only; rerun scenario 6 after F-1) | — | doc |

Parallel now: **F-1 ∥ T-1 ∥ T-2 ∥ QA-1** (four independent tracks). Critical path to the
canary: T-1 → T-3 → C-1 → (C-2). E-1 is gated on telemetry data plus the QA exit
criterion, matching the summary's ordering.

## §8 Test strategy

New: `useRegisterUiTools` flag-matrix (undefined/true/false × mount/mid-session flip);
I5 manifest-policy exact-match test; resolver rejection-reason matrix; group-scoped
abort hang-safety; canary unit tests (§5).

**Must NOT change:** the exact-12 catalog test (`ui-tools-catalog.test.ts:42-65`), atlas
determinism + 12k cap (`app-surface-coverage.test.ts:162-169`), the `hostedBlocked`
policy test (`:133-138`), bidirectional route↔manifest coverage, approval-parity tests,
`surface-snapshot-coverage.test.ts`. A workstream that needs to modify one of these is
off design — stop and re-check §2.

## §9 Rollback and kill-switch matrix

| Symptom | Switch | Blast radius | In-flight turns |
|---|---|---|---|
| Agent misbehaving / safety failure in the wild | PostHog `agent-chat-enabled` → `false` | Hero + panel gone, catalog unregistered, mirror clean; playground chat untouched | error cleanly (`shippedNames`), no hang |
| Cache canary suspected of quality regression | unset `MCPJAM_PROMPT_CACHE_CANARY` | providerOptions/`promptCache` stop being emitted; telemetry keeps flowing | next turn uncached |
| UI-only contract itself wrong | `MCPJAM_AGENT_PLATFORM_TOOLS=1` | full restore of platform server + preflight + workspace prompt | server-side, per-turn |
| One tool group misbehaving (post-E-1) | its `agentToolsFlag` → off | that group only; base 12 unaffected | group calls error cleanly |

## §10 Open items / external dependencies

- Hosted backend `promptCache` support (C-2) — external repo; contract in §5.
- PostHog ops: create `agent-chat-enabled` "on for all" before F-1 deploys; create each
  `agentToolsFlag` flag (off) before its E-1-style PR deploys.
- Baseline-window length for §4's exit criterion — decide from data volume once T-2 is
  live.
- Delete the stale `playground-enabled` references from
  `client/src/__tests__/App.hosted-oauth.test.tsx` opportunistically (it gates nothing).
