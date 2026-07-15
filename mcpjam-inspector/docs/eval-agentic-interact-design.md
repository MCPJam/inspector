# Design: per-step agentic interact (computer-use) in evals

**Status:** DESIGN — no production code. This is R4 from the
`eval-widget-interaction-replay` follow-ups; R1–R3 (observability, helper dedup,
loop consolidation) shipped first. Per TL review, R4 is product surface area and
must resolve three blockers before any implementation.

## Goal

Let an authored eval step *optionally* drive a widget **agentically** — the model
drives by screenshots via the `computer` / `finish_widget` tools, the way
Swarm/session-simulation does — **opt-in per step, never a global switch**, so
deterministic grading is preserved for the default scripted `interact`.

Today eval `interact` is always deterministic: `runInteractStep` →
`browser.replayInteractStep` replays a recorded click/type
(`step-executor.ts`, `browser-session-context.ts`). The invariant is explicit:
the eval runner **never** passes `enableComputerUse: true` to
`createBrowserSessionContext`; only the `sessionSimulation` runner does.

## The three blockers (and recommended resolutions)

### 1. Tool construction is gated at context-construction time

**Problem.** `computerWidgetTools` (the `computer` + `finish_widget` tool set) and
the `prepareAdvertisedTools` gate are built **once, at `createBrowserSessionContext`
time**, only when `enableComputerUse === true`. An eval context is constructed
`enableComputerUse`-free, so the tools don't exist — a per-step mode can't just
"turn them on" later.

**Recommendation — narrow, lazy capability, not the global flag.** Add a
context-level capability that *can build* the computer tools on demand without
flipping the global agentic default:
- Keep `enableComputerUse` meaning "advertise computer tools for ALL turns"
  (session simulation's behavior) — unchanged.
- Add `allowAgenticSteps?: boolean` (eval sets this true). When set, the context
  exposes a `buildComputerWidgetToolsLazily()` / `getComputerWidgetTools()` that
  constructs the tool set + the mount-gated `prepareAdvertisedTools` **on first
  use**, scoped to the caller. The capability probe
  (`resolveComputerUseToolVersion` / `modelSupportsComputerUse`) runs once and is
  cached, same as today.
- Eval’s `createBrowserSessionContext` call still passes `enableComputerUse:
  false`; it passes `allowAgenticSteps: true`. So normal `prompt`/`interact` turns
  see no computer tools; only an `agentInteract` step pulls them in for its own
  model turns.

This keeps "computer tools off by default for evals" true, while making them
constructible per step. (Alternative considered: build eagerly with
`enableComputerUse: true` and filter at advertise — rejected, it re-introduces the
global agentic surface the invariant forbids.)

### 2. `InteractStep` schema — discriminated union, not optional fields

**Problem.** `interactStepSchema` *requires* a scripted `action`. Bolting
`driver: "computer"` + optional `goal` onto it means agentic steps carry a
dummy/ambiguous scripted `action`.

**Recommendation — a new `agentInteract` step kind** (discriminated union peer of
`interact`), NOT a field on `InteractStep`:
```ts
// shared/steps.ts
agentInteractStepSchema = z.object({
  id: z.string(),
  kind: z.literal("agentInteract"),
  toolName: z.string().min(1),          // the widget to drive
  // A goal is an eval directive, not recorded step text — give it its own cap
  // (MAX_AGENTIC_GOAL_CHARS), don't reuse MAX_SCRIPTED_STEP_TEXT_CHARS.
  goal: z.string().min(1).max(MAX_AGENTIC_GOAL_CHARS),
  maxActions: z.number().int().positive().max(20).optional(),
  budgetTokens: z.number().int().positive().optional(),
  // Wall-clock bound. maxActions/budgetTokens cap iteration count and spend but
  // NOT time; without this a model that stalls on tool execution or retries on
  // transient failures could hang the runner. The loop aborts on elapsed time.
  timeoutMs: z.number().int().positive().optional(),
});
// TEST_STEP_KINDS += "agentInteract"; TestStep union += agentInteractStepSchema
```
Rationale: scripted `interact` and agentic `agentInteract` have **disjoint**
payloads (recorded `action` vs free-text `goal` + budgets). A discriminated union
keeps each shape clean and lets the executor/authoring/replay narrow on `kind`
(the same pattern `interact`/`assert`/`prompt`/`toolCall` already use). A
`driver` field on one schema would make half its fields conditionally-required —
exactly the ambiguity to avoid.

### 3. Transcript semantics — decide BEFORE building

**Problem.** Does the agentic step's `goal` (and the model's computer-tool actions)
enter the chat transcript, or stay eval-harness-only? This drives grading, trace
spans, usage/billing, and reproducibility — it must be settled up front.

**Recommendation:**
- **Goal → NOT a chat user turn.** The `goal` is an *eval directive*, not user
  speech. Putting it in the transcript would pollute the conversation a
  `toolCalledWith`/judge reads and mislead reproductions. Instead, the agentic
  loop runs as harness-internal model turns whose *system* framing carries the
  goal (mirrors how `interact` actions are artifacts, not transcript — see
  `project_eval_interactions_are_artifacts`).
- **Tool calls the agent makes → real, attributed.** Any `tools/call` the widget
  issues during the agentic loop is a genuine protocol event: record it exactly
  like a scripted interact's `widgetToolCalls` (PR1 plumbing) and bucket it into
  the step's turn for `toolCalledWith` (the established interact contract). A
  `ui/message` the widget sends → drives a follow-up turn (R3 path), same as
  scripted.
- **Spans + usage → attributed to the step's `turnOrdinal`.** Each agentic model
  turn is a real billable turn (`feedback_evals_first_class_billable`); stamp its
  spans with the step's promptIndex (the existing `onAction`/render pipeline
  already records browser-interaction artifacts).
- **Reproducibility caveat — state it loudly.** An `agentInteract` step is
  **nondeterministic by construction** (model-driven). It is the one eval step
  whose replay won't be byte-identical. Grading should target *outcomes*
  (`toolCalledWith view-cart`), not exact action sequences. This is the core
  trade vs scripted `interact` and must be surfaced in the authoring UI.

## Implementation sketch (after the above are approved)

- `shared/steps.ts`: add `agentInteractStepSchema` + union/kinds.
- `server/services/evals/step-executor.ts`: a `runAgentInteractStep` branch that
  loops bounded model turns through the existing `onPrompt`/engine seam with the
  step-scoped computer tools advertised (blocker #1's lazy builder), capped by
  `maxActions`, `budgetTokens`, **and `timeoutMs`** — the loop checks elapsed
  wall-clock each turn and aborts once it exceeds `timeoutMs`, so a stalled tool
  call or retry storm can't hang the runner. Actions are recorded via the
  existing harness `onAction` callback, then `ui/message` follow-ups are drained
  (R3). The step-scoped tool builder in `browser-session-context.ts` threads the
  timeout through to the engine call.
- `browser-session-context.ts`: the lazy/step-scoped tool builder (#1).
- No global `enableComputerUse` change for evals.

## Deferred surface (explicit follow-on, not in the first agentic PR)

- **Authoring UI** (`add-step-picker`): an "agentic interact" option with goal +
  budget inputs, and a clear "nondeterministic" badge.
- **Recorder**: there's nothing to record for an agentic step (it's a goal, not a
  script) — but the authoring flow should let you *convert* a scripted interact
  into a goal, or seed a goal from a recorded session.
- **Grading docs**: guidance that agentic steps assert outcomes, not sequences.

## Open questions for the TL

1. Budget unit: `maxActions` (simple, predictable) vs `budgetTokens` (cost-true)
   vs both? Recommendation: both optional, `maxActions` default 20.
2. Should a failed agentic step (goal not reached within budget/time) fail the
   iteration fail-fast like a failed scripted `interact`, or record a soft
   "goal-not-met" verdict? Recommendation: fail-fast (matches `interact`), with
   the reason captured. Partial state is **retained, not rolled back** — unlike an
   atomic scripted `interact`, an agentic loop may have issued several tool calls
   and mutated browser state before failing, so: the iteration error records the
   last attempted action; tool calls already issued stay in `toolCallsByTurn` for
   grading (they are real, attributed protocol events — see the transcript rules
   above); and the transcript keeps the partial agentic turns. A failed
   `agentInteract` is therefore debuggable, not an opaque timeout.
3. Do we gate the whole feature behind a flag for the first ship (given it's the
   first nondeterministic eval step), even though R3's follow-up loop shipped
   unflagged? Recommendation: yes — `agentInteract` is a new authored capability,
   flag it until validated.
