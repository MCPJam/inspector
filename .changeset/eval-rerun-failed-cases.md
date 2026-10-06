---
"@mcpjam/inspector": patch
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
---

Rerun a finished eval run's failed cases as a new run with `mcpjam cloud eval rerun <run-id> --failed` (add `--dry-run` to see which cases would rerun and why), `POST /api/v1/projects/{projectId}/eval-runs/{runId}/rerun`, or the SDK's `rerunEvalRun` and `getEvalRunRerunPreview`. The platform picks the cases. The new run records `rerunOfRunId` and `rerunScope`, and because it ran only what failed, it no longer counts toward the suite's latest run, trends, totals or comparison baselines.
