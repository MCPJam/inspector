---
"@mcpjam/sdk": minor
---

A credit block now carries the exact call that resumes it. `run_eval_suite` accepts `resumeFromRunId`, which reruns only a credit-stopped run's unfinished cases on that run's own target. `get_eval_run` reads `creditRecovery` from the run record when the backend stores it, falling back to the per-iteration read, and returns `resume` and `incompleteCases` for a credit stop a person must clear. A refused launch, and a fan-out target refused for credits, return `resume`: the same launch replayed under the same idempotency key, which starts only the targets that did not start. New exports: `isCreditBlock`, `replayLaunchResumeInstruction`, `stoppedRunResumeInstruction`, `resumeSourceOfRun`, `parseResumeSelection`, `incompleteCasesOfRun`, `incompleteCasesOfIterations`, `readEvalRunIncompleteCases` and `INCOMPLETE_CASES_LIMIT`.
