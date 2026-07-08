# Eval widget-interaction replay (MCP Apps)

**Status:** landed in working tree (branch `evals-ui-polish`), tests green, verified
end-to-end. Backend validator changes on `mcpjam-backend@add-evals-backend-changes`.

## TL;DR

Evals now faithfully replay MCP App widget interactions, matching Playground:

1. **See it** — the Chat/Trace tab renders widget→host `tools/call`s as app-attributed
   cards (PR1).
2. **Reason over it** — the model can be told what a widget interaction returned (PR2,
   flagged).
3. **Drive the conversation** — a widget's `ui/message` (e.g. a "Show my cart" button)
   now triggers a real model turn that calls the resulting tool (PR3, on by default).

Verified: `search-products` → click **Add to cart** → click **🛒 (Show my cart)** →
model calls **`view-cart`** → cart renders with the item → **3/3 checks pass**.

---

## Problem & root cause

An eval test case is a fixed `TestStep[]` (`prompt` / `interact` / `toolCall` / `assert`)
walked **headless** by a sequential step-executor. Playground is a **live `useChat`
loop** in the browser. That structural difference is the whole story:

- In Playground, anything that happens (a widget click, a tool result) flows back into
  the running conversation and the model **auto-continues**.
- In an eval, steps are pre-planned and the model only runs on `prompt` steps. A widget
  click in an `interact` step executed against the real server, but its **consequences
  never reached the model** — and the Chat tab showed nothing.

The canonical failure: a storefront widget's **cart button sends a `ui/message`
("Show my cart"), not a tool call**. The harness *captured* that message
(`browser.drainFollowUps()`) but — after the unified-TestStep refactor — nothing
*drove* it, so `view-cart` never fired and the assertion stayed red.

---

## The three interaction loops in the product (context)

There isn't one "widget loop" — there are three, and they differ in *who drives*:

1. **Live human chat (Playground *and* ordinary chatbox)** — `useChatSession` owns the
   browser `useChat` loop. Widget app-tool results feed back via `addToolOutput`;
   `sendAutomaticallyWhen` auto-continues after tool results/approvals; widget
   `ui/message` flows through the `Thread` renderer callbacks into `sendMessage`.
   (`use-chat-session.ts:1671`, `:1830`; `PlaygroundMain.tsx:2402`.)
2. **Swarm / synthetic chatbox (session simulation) — agentic computer-use loop.**
   Explicitly constructs `BrowserSessionContext` with `enableComputerUse: true`, injects
   `computer` / `finish_widget`, and loops persona turns until `maxTurns`/`endSession`.
   The *model* drives the widget by screenshots. (`sessionSimulation/runner.ts:551`, `:571`.)
3. **Evals — authored mixed loop.** Deterministic `prompt`/`toolCall` model turns +
   human-like `interact`/`assert` steps. Evals **do not** enable computer use by default
   (kept deterministic for grading; `browser-session-context.ts:374`). This work adds the
   `ui/message` follow-up turn to that mix.

This doc's "Playground vs eval" comparisons mean loop (1) vs loop (3). Loop (2) is a
separate, genuinely agentic path and is out of scope here (but see Follow-up #5).

---

## What we built (3 PRs)

### PR1 — App-attributed render + carry `result`/`visibility` (no behavior change)

The Chat/Trace tab renders each widget call as the **same** MCP-branded
`AppToolInvocationPart` Playground uses, reconstructed from the persisted trace.

- `server/utils/mcp-app-browser-harness.ts` — `WidgetToolCall` carries `result` +
  `visibility`; new `resolveToolVisibility` option.
- `server/services/browser-session-context.ts` — resolves SEP-1865
  `_meta.ui.visibility` via `getAllToolsMetadata` (default `["model","app"]`).
- `shared/eval-trace.ts` — `EvalTraceWidgetToolCall` gains `result`/`visibility`.
- `client/.../widget-tool-calls-to-app-invocations.ts` (new) + `thread.tsx`
  (`appToolInvocationsOverride`) + `trace-viewer.tsx` (derive & pass).
- **mcpjam-backend** — `result`/`visibility` added to all **3** strict Convex
  validators (`browserArtifactValidators.ts`, `persistEvalTraceAction.ts`, `schema.ts`).

### PR2 — Model context for widget tool results (flagged off)

The model can reason over a widget interaction. Built by **reusing Playground's own
server-side mechanism** rather than hand-rolling message injection.

- `server/utils/chat-v2-orchestration.ts` — `buildWidgetInteractionContextSystemPrompt`,
  a sibling of the existing `buildWidgetModelContextSystemPrompt` (the helper Playground
  already uses for `ui/update-model-context`), reusing the same content-block renderer.
- `server/services/evals/widget-interaction-context.ts` (new) — collects model-visible
  widget calls (app-only `["app"]` excluded via the SDK's `isAppOnlyTool`).
- `drive-local-eval-turn.ts` / `drive-hosted-eval-turn.ts` — one gated line each
  appending the addendum to `systemPrompt`.
- Flag `MCPJAM_EVAL_WIDGET_MODEL_CONTEXT` (off by default).
- **Zero** impact on message arrays / persisted transcript / matcher — it only touches
  the system-prompt string.

### PR3 — `ui/message` follow-up re-drive (on by default, bounded) — the actual fix

- `server/services/evals/step-executor.ts` — `drainAndDriveFollowUps` in the `interact`
  branch: bounded `drain → drive → re-drain` loop, fail-fast on error, and a
  **drained-count log** (the observability seam).
- `server/services/evals/step-handlers.ts` — new `onFollowUp` in both local + hosted
  handlers. Reuses `driveLocalEvalTurn`/`driveHostedEvalTurn`.
- Bounded by `MAX_WIDGET_FOLLOWUP_TURNS`. **No flag** — the flag would only have
  preserved the buggy "drop the message" behavior; the bound is the real safety. No-op
  for evals without widget `ui/message`s.

**One correctness trap, called out and tested:** the follow-up turn's tool-call delta
must be derived from the **new messages**, NOT `acc.toolsCalledByPrompt[turnOrdinal]` —
which, for a follow-up that *shares* the interact's turn, still holds the **parent
turn's** calls. Using the index there is a silent mis-grade. Both unified evaluators read
`state.toolCallsByTurn` (`step-verdict-adapters.ts:42`), so we `applyOutcome` into the
interact's turn and the turn-scoped assert sees `view-cart`.

---

## Divergence from Playground (deliberate, honest)

| Aspect | Playground | Eval (this work) |
|---|---|---|
| **Tool-result → model context** | `addToolOutput` appends to `useChat` messages; browser-only | Can't run `useChat` headless. PR2 injects a **system-prompt note** server-side (reuses `buildWidgetModelContextSystemPrompt`). Flagged off. |
| **`ui/message` follow-up** | `useChat.sendMessage` → auto-continue | PR3 drains the captured message and drives a continuation turn. |
| **Auto-continue trigger** | `sendAutomaticallyWhen` predicate (`use-chat-session.ts:1830`) — any appended message auto-drives | No live loop. The model runs only on `prompt` steps + the explicit follow-up drive. |
| **Turn attribution** | `ui/message` is a fresh conversation turn | Follow-up **shares the interact's turn ordinal** so a turn-scoped `toolCalledWith` assert sees the call. |
| **Bound** | Unbounded / user-paced | Bounded by `MAX_WIDGET_FOLLOWUP_TURNS` (runaway-widget guard). |
| **Persistence** | Live transcript | PR2 context is **ephemeral** (system prompt only, never persisted); PR3 follow-up **is** a real persisted turn. |

Net: the *mechanisms* differ because headless ≠ browser, but the *observable behavior*
(click → model reacts → tool fires → widget renders) matches.

---

## Reuse / refactor opportunities

1. **Two follow-up loops now exist.** `drive-hosted-eval-turn.ts:541` has the legacy
   per-prompt-turn recursion; `step-executor.ts` (PR3) has the unified interact-step
   loop. In the unified model, interactions are their own steps, so the hosted
   recursion is largely redundant. **Consolidate on the executor-owned loop.**
2. **`onFollowUp` ≈ `onPrompt` minus a bug.** The only real difference is that
   `onFollowUp` derives its tool-call delta from new messages instead of the fragile
   `acc.toolsCalledByPrompt[turnOrdinal]` index. **Extract a shared "drive a turn, return
   message-derived delta" helper and have `onPrompt` use it too** — that kills the
   index fragility everywhere (it's only "safe" in `onPrompt` because each prompt gets a
   unique ordinal).
3. **Good reuse already banked:** PR1 renders via Playground's `AppToolInvocationPart`
   1:1; PR2 reuses Playground's `buildWidgetModelContextSystemPrompt`. No forks.

---

## Follow-ups (prioritized)

1. **Surface `ui/message` follow-ups as first-class trace/Steps artifacts**, not just a
   log line. Today a failed run can't *show* "🛒 → sent 'Show my cart'"; that cost us a
   lot of debugging time. (The drained-count log is a stopgap.)
2. **Decide PR2's flag** — system-prompt context injection is more interpretive (it's
   *our* choice of how to feed results to the model). Keep gated or promote.
3. **Consolidate the two follow-up loops** (item 1 in Reuse).
4. **Harden the turn-delta** to be message-derived across `onPrompt`/`onFollowUp` (item 2).
5. **Recorder locator hardening.** The recorder gave Add-to-cart a clean
   `role=button[name="Add to cart"]` but fell back to `text="🛒"` for the cart — fragile.
   Ties into the existing generate-and-verify recorder-locator work.
6. **Deploy ordering (cross-repo):** the backend Convex validators must deploy
   with/before the inspector (the inspector now writes `result`/`visibility`).
7. **Persistence scope:** PR2 context is deliberately kept out of the chatSessions
   writer; revisit under the chatSessions-unification workstream.

---

## Verification

- Unit: PR1 (6) + PR2 (8) + PR3 (5) tests, all green. `tsc` clean on touched files.
  Existing executor / drive / browser-session / finalize suites green.
- **Not ours:** 16 `runner-parity.test.ts` snapshot failures are a separate in-flight
  `stepResults` change (`evals-runner.ts`/`finalize-iteration.ts`).
- E2E (run 108): add-to-cart → "Show my cart" → `view-cart` → cart shows the item →
  **3/3 checks passed**.

## Flags

| Flag | PR | Default |
|---|---|---|
| `MCPJAM_EVAL_WIDGET_MODEL_CONTEXT` | PR2 | off |
| *(none)* | PR3 | on, bounded by `MAX_WIDGET_FOLLOWUP_TURNS` |
