---
"@mcpjam/sdk": minor
---

Add the canonical evaluator contract beside the score contract.

An evaluator is an assertion or a judge, and both report one result shape. The
new names are additive: `ScoreResult`, `Scorer`, `PREDICATE_STAGE` and the rest
keep working, and the definitions underneath are the same objects with the same
hash payload — so adopting the canonical vocabulary does not change what any
existing suite grades or what identity its evaluators carry.

`EvaluatorDefinition` and friends are type aliases, deliberately. Their runtime
keys are the `definitionHash` payload, and renaming one would rotate every
evaluator identity in every stored run while looking exactly like a changed
configuration. `EvaluatorResult` is the one shape that genuinely renames fields
— `value` becomes `score`, `rationale` becomes `explanation` — so it is a
versioned projection with an exact inverse rather than an alias over a
differently-shaped object.

Three rules survive intact: `passed` stays derived from
`score >= passThreshold`, a result that was not scored carries no `score` at
all, and role and error policy stay on the definition where there is one copy
of them. The canonical schema enforces them by projecting onto the score
schema rather than restating them, because two implementations of "did this
pass" is the disagreement the contract exists to prevent.

`EvaluatorKind` is derived from `deterministic` rather than stored — storing it
would add a twelfth field to the hash payload for a value already implied by one
that is there.
