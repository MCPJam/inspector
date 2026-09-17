---
"@mcpjam/sdk": patch
---

Report the model on every iteration an `EvalSuite` or `EvalTest` run uploads. A run started with `runWithClient` showed an empty MODEL column, because only the `promptsToEvalResult` path stamped the provider and model that the run had already recorded. When a case fails in setup and never reaches the model, the run now names the model it was configured with — the saved client's, for a `runWithClient` run.

Report per-step verdicts too (`metadata.stepResults`), the same rows the hosted runner writes. An SDK case whose tool call matched still read "0 of 1 assertion passed" on the Steps tab, with a grey unknown icon, because no step ever carried a verdict.
