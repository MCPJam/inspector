---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
"@mcpjam/inspector": patch
---

Credit refusals now tell agents how to recover, with one action and an exact resume command. When MCPJam credits refuse an `mcpjam cloud eval run` launch, or stop a run partway, and the step is one a person must take (anything but `wait`), the CLI exits `6` (blocked) and `eval status` on the run exits `6` too. Human output prints the one-action `Recovery:` line and a `Resume:` command; JSON carries `resumeCommand`. The resume command is the same launch with `--resume` (a refused launch, reusing the idempotency key) or `--resume --resume-from <runId>` (a stopped run, which reruns only that run's unfinished cases, mapping to `startTestSuiteRun.resumeFromRunId`). Running a resume that is refused again prints `Still blocked:` and exits `6`, never retrying on its own. `run_eval_suite` and the CLI's `eval run` accept `resumeFromRunId` / `--resume` / `--resume-from`.

`get_eval_run` and `eval status`/`eval run --wait` now prefer the `creditRecovery` the run record carries, falling back to the per-iteration read on older deployments; the Inspector records the refusal's recovery on the run when a credit stop fires. A credit stop from a deployment that sends no `recovery` now points the reader to the billing page to upgrade the plan **or** add credits, instead of only "upgrade the plan" (wrong for a paid plan).
