---
"@mcpjam/sdk": minor
"@mcpjam/evaluators": minor
---

Local eval results now count tool errors the same way MCPJam does. A failed tool call and an iteration error each write a score row (`platform:toolExecution`, `platform:iterationError`), and `test.accuracy()`, `result.aggregate.accuracy` and the uploaded `passed` all come from the same rows. An iteration whose tool call errored, even if the model retried and got the right answer, now fails locally too, unless the run sets `failOnToolError: false`, which makes both rows advisory.

- Each case's evaluation config gains these two definitions, so comparing your first run on this version with an older run shows "evaluation config changed" once.
- `promptsToEvalResult` and `PromptResult.toEvalResult` now upload score rows built from your `passed` value plus the two platform checks. Use the same `failOnToolError` for every call within one case: the backend rejects a case whose iterations report different evaluation configs.
- Suite-file runs always apply the tool-error check.
- Deprecated: `finalizePassedForEval` (use `scoresPassed`), and the `failOnToolError` option on `iterationToEvalResult`, `runToEvalResults`, `suiteRunToEvalResults` and the reporter's `addFromRun`/`recordFromRun`/`addFromSuiteRun`/`recordFromSuiteRun`, which no longer has any effect: set it on the run instead.
