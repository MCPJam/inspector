---
"@mcpjam/sdk": major
---

Publish the versioned eval run **verdict policy** contract (`verdictPolicyVersion: 2`).

**Breaking** for TypeScript consumers of the suite loader, additive everywhere else.
`resolveEvalSuiteFile`'s exported result type changed shape: `ResolvedEvalSuiteFileValidity`
no longer carries an optional `minEligibleTrials` and now requires a `coverage`
discriminated union, so code that reads `validity.minEligibleTrials` — or builds a
resolved-validity object — stops compiling. No runtime input changes: authored suite
files, wire payloads and thresholds are untouched, and no backwards-compatible alias
is kept, because an optional `minEligibleTrials` is exactly the reading ("omitted means
no minimum") this release corrects.

Otherwise contract-only: `@mcpjam/sdk/contract` (and the main entry) now export
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

A case aggregate is identified by `caseId` **and** an optional `executionVariant`
(`model`, optional `provider`), so a run fanned out across providers or models keeps one
aggregate per variant instead of collapsing them onto the case. Repetition caps stay
per-variant, mixing variant-keyed and unkeyed aggregates for one case is rejected, and
`evalCaseAggregationKey` ships so every consumer groups on the same identity.
