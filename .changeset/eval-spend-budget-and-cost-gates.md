---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
---

Eval spend: an organization budget, cost as a result, and cost gates.

`PlatformApiClient` gains `getSpendBudget`, `setSpendBudget` and
`clearSpendBudget`, backed by the new `PlatformSpendBudget` type. A budget is
opt-in: with no cap set, spending is unchanged and uncapped.

Cost now travels with a run. `PlatformEvalIteration.usage` is a typed object
rather than a bare record (it keeps an index signature, so an unknown key still
round-trips), `PlatformRunCompare` gains `costCoverage`, and
`buildRunCompareReport()` returns a `metrics` block.

Two new gates: `GatePolicy.maximumCostUsd` and
`GatePolicy.maximumCostIncreasePercent`, with `maximumCostIncreasePercent`
added to `COMPARATIVE_GATE_FIELDS`, plus the matching `mcpjam cloud eval gate`
and `eval compare` flags. Cost coverage is reported honestly: a run whose cost
is only partly known is `non_gateable` rather than silently passing, and a
missing cost is `null`, never `0`.
