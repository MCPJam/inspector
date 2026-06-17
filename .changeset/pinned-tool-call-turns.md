---
"@mcpjam/inspector": minor
"@mcpjam/sdk": minor
---

Unify render checks into a model-free per-turn pinned tool call.

- **@mcpjam/inspector**: replace the standalone `widget_probe` synthetic
  monitor with a per-turn `pinnedToolCall`. When a turn carries one, it is
  model-free: the runner executes that exact tool call (fixture input) and
  renders its widget through the same `browser-session-context`
  render+observe pipeline the model turns use — no LLM in the loop. The
  pinned-turn logic lives in one place (`server/services/evals/pinned-turn.ts`)
  shared by the local AI-SDK, hosted backend, and streaming iteration paths,
  and the legacy `probe-iteration.ts` / `widget-probe-editor.tsx` are removed.
  New `prompt-turns` selectors are the single source of truth for "is this turn
  model-free?", reading the per-turn field structurally and falling back to the
  legacy `caseType === "widget_probe"` shape so answers stay correct before any
  per-turn pinned data exists. A pinned-first turn (empty prompt) synthesizes a
  stable descriptive query so display, dedup/upsert identity, and query
  validators keep working. New `pinned-tool-call-fields.tsx` editor surface.

- **@mcpjam/sdk**: `buildIterationTranscript` accepts a new optional
  `toolErrors` on `BuildTranscriptInput`, merged with trace-derived errors. A
  model-free pinned tool call has no trace for `extractToolErrors` to read, so
  its content/protocol errors must be passed explicitly — otherwise
  `noToolErrors` would pass falsely. Additive and backwards compatible.
