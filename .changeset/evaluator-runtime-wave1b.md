---
"@mcpjam/sdk": minor
---

Add `assertion()`, `judge()` and `runEvaluators()`, plus the
`@mcpjam/sdk/assertions` subpath.

These are the canonical spellings of `predicateScorer`, `judgeScorer` and
`runScorers`, and they build through the same functions rather than beside
them. `assertion(rule)` produces the same definition as `predicateScorer(rule)`
— same opaque id, same `implementationHash`, same `definitionHash` — which is
what lets an author migrate one rule at a time without the run they compare
against becoming a different run. The tests assert that equality directly
rather than asserting the two look similar.

`runEvaluators` accepts either vocabulary in one list and delegates to the
existing bounded runner. It does not reimplement the per-evaluator timeout, the
concurrency cap, or the rule that every failure lands as an error row rather
than a low score: a second bounded runner would be a second place for "what
happens when a judge hangs" to be answered, and the two answers would drift in
the direction nobody tests.

`@mcpjam/sdk/assertions` is a barrel over the existing library, not a move.
`@mcpjam/sdk/predicates` keeps resolving to the same objects — the two subpaths
are one library with two spellings, and a consumer importing either gets
identical values.

`assertion()` splits an `id` off before building the definition, so naming a
rule does not change the digest of what that rule does. An unnamed assertion
gets a content-derived id rather than a positional one, because a standalone
evaluator has no position and two anonymous rules of the same type would
otherwise collide in the snapshot.
