---
"@mcpjam/sdk": minor
---

Add the per-run scorer-rollup comparability contract

**A trend is a claim that two runs measured the same scorer over the
same population.** That claim needs a canonical identity before the
backend materializer exists, so later mirrors cannot invent a digest
over an undocumented subset. `@mcpjam/sdk/contract` now exports
`EvalScorerRollupV1`, `scorerRollupParityBlockers`, and
`scorerRollupsComparable`. Entries are keyed by `(scorerId, definitionHash)`
and carry explicit `countable` denominators — there is no `measured`
field. Rates stay fractions in [0, 1] or `null`; `null` means
unmeasured, never `0`. A truncated or provisionally materialized
document is not comparable. An environment id is never substituted for
frozen host, model, or server facts.
