---
"@mcpjam/inspector": minor
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
---

Run evals under the v2 verdict policy end to end: explicit lifecycle status, an
`inconclusive` verdict, and the backend's decision reported verbatim.

Lifecycle status stops being inferred from the task verdict. An iteration result
carries an explicit `status` — `pending`, `running`, `completed`, `failed`,
`cancelled`, `timed_out`, `setup_failed` or `skipped` — and a normally executed
case that the grader failed is `status: "completed"` with a failed verdict, not
`status: "failed"`. The old inference survives only for wire payloads from an SDK
that never sent a status, in one named adapter
(`legacyIterationStatusFromExecutionError`) that reads the execution error and
never reads `passed`.

`EvalRunResult.result` gains `"inconclusive"`: a run whose validity could not be
established (too few completed trials, too many evaluator errors, nothing
gradeable) is no longer reported as a failure of the server under test. The
reporter sends the v2 wire marker with per-case `repetitions`, fractional
`passThreshold`s and the validity policy on run start — where the backend freezes
it — and reads back `verdictPolicyVersion`, `verdictSummary` and
`verdictPolicyIntegrityError`.

Consumers report that decision instead of recomputing one. `buildStructuredReport`
carries the backend summary (reasons, denominators, exclusions) into report
metadata and no longer synthesizes a failing case for a run nobody could grade;
GitHub Checks and the run/commit/tag UI render `inconclusive` as amber rather than
green or red, and leave it out of pass-rate metrics and trends. `eval-gate` exit
codes are unchanged — an inconclusive run is not gateable, so it exits 3 (not
gated), never 1 (verdict failed) — and `eval run --wait` keeps its shipped
mapping.
