---
"@mcpjam/inspector": minor
"@mcpjam/sdk": minor
---

Let an advisory judge attribute a selection failure to misleading tool metadata (D7).

`deriveStageResults` never GUESSES `failureCategory: "metadata"` from
deterministic evidence — attributing a selection miss to a misleading tool
name, description or schema is a judgement about intent that no span
carries. The stage analyzer gains a second tier-2 evidence field,
`StageEvidence.metadataAttribution`, consulted only after `selection` has
already failed deterministically (`missingToolCall` / `unexpectedToolCall`).
A scored verdict with `attributed: true` recolors that run's
`failureCategory` from `"selection"` to `"metadata"` and merges the judge's
quoted evidence into the `selection` row; the row's own `state` and `reason`
are never touched, and the branch is structurally unreachable once
`connection` or `discovery` has already broken the chain. Analyzer version
becomes 4.

The judge itself is report-only and gated by the same `dual_write`
grading-engine mode B3a introduced: it never gates a run, never moves
`passed`, and treats every tool description as untrusted content fenced
against prompt injection, mirroring the discipline `classifyToolSafety`
already applies to tool annotations. Nothing changes until a suite runs
under `dual_write` and hits a deterministic selection failure.
