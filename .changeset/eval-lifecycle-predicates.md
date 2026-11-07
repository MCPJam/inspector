---
"@mcpjam/sdk": minor
---

Export one definition of eval run and iteration lifecycle from `@mcpjam/sdk/contract`: `EVAL_RUN_STATUSES`, `isEvalRunTerminalStatus` (a run whose verdict can be read; `grading` is not terminal), `isEvalRunPastExecution` (nothing left to execute, terminal or `grading`) `isEvalIterationTerminalStatus`, and the two no-verdict predicates `isEvalRunNonVerdictStatus` (`failed`, `cancelled`, `timed_out`) and `isEvalIterationNonVerdictStatus` (`cancelled`, `timed_out`, `setup_failed`, `skipped`).
