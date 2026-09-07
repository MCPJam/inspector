---
"@mcpjam/sdk": minor
---

Add the suite quality-gate contract

**A stored suite policy had no canonical evaluator.** The flag gate and
`evaluateCompareGates` still answer one-run and statistical-regression
questions; they do not evaluate a per-scorer observed-rate drop or compose
that answer beside a waived flag report. `@mcpjam/sdk/contract` now exports
`SuiteGatePolicyV1`, `evaluateSuiteGateEvidence`, and
`composeSuiteGateWithBaseReport`. Absolute and comparative conditions are
independent, `previous_completed` is typed but refused on writes, and a run
waiver never covers the suite policy.
