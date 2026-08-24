---
"@mcpjam/sdk": minor
---

Publish the versioned eval run **verdict policy** contract (`verdictPolicyVersion: 2`).

Additive and contract-only: `@mcpjam/sdk/contract` (and the main entry) now export
`EvalRunVerdict`, `EvalVerdictDecision`, `EvalCaseVerdictAggregation`,
`EvalRateMeasurement`, `ResolvedEvalValidityPolicy`, their validators, and the
generated draft 2020-12 JSON Schema. Nothing produces a decision yet — no
aggregator ships in this change, and no existing run, iteration, wire payload or
percent-threshold behavior moves. A row with no `verdictPolicyVersion` is a legacy
row and is never read as v2.

The contract makes two things explicit that were previously left to whoever
computed a verdict. Validity is evaluated **before** the task verdict, so a run
that was not adequately measured is `inconclusive` rather than `failed` — blaming
the server for a harness or grader problem is a different claim. And every rate
carries its own numerator, denominator and exclusions, so a zero denominator is
`state: "notMeasured"` with a `null` value instead of a vacuous pass.

One behavioral correction comes with it: an omitted `defaults.validity.minEligibleTrials`
never meant "no minimum", though the suite-file comment said so. It resolves to the
default coverage floor — every configured trial attempted, plus at least one
gradeable trial — and `ResolvedEvalSuiteFileValidity` now carries that as a
`coverage` discriminated union. An explicit `minEligibleTrials: N` replaces the floor
with `eligibleTrials >= N`. Authored suite files are untouched; only the resolved
in-memory value changes.
