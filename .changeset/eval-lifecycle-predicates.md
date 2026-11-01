---
"@mcpjam/sdk": minor
---

Export one definition of eval run and iteration lifecycle from `@mcpjam/sdk/contract`: `EVAL_RUN_STATUSES`, `isEvalRunTerminalStatus` (a run whose verdict can be read; `grading` is not terminal), `isEvalRunPastExecution` (nothing left to execute, terminal or `grading`) and `isEvalIterationTerminalStatus`.
