---
"@mcpjam/sdk": patch
---

Report the model on every iteration an `EvalSuite` or `EvalTest` run uploads. A run started with `runWithClient` showed an empty MODEL column, because only the `promptsToEvalResult` path stamped the provider and model that the run had already recorded. When a case fails in setup and never reaches the model, the run now names the model it was configured with — the saved client's, for a `runWithClient` run.
