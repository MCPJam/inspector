---
"@mcpjam/sdk": minor
---

Adds `PlatformApiClient.testEvalCodeEvaluator`, which runs an unsaved code evaluator once against one iteration of a suite's finished run, in a fresh sandbox, without saving anything. The result has the score and whether it passes the threshold, or the error, with the output, and says whether the evaluator graded the run's own stored input or one rebuilt from the transcript. `codeEvaluatorTestRequestSchema` and `codeEvaluatorDraftSchema` check a draft with a saved evaluator's limits. Client methods take a `minTimeoutMs` request option, and a test uses it to get `CODE_EVALUATOR_TEST_TIMEOUT_MS` (five minutes) even from a client with the 30-second default.
