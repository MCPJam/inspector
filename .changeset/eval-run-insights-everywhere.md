---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
"@mcpjam/inspector": patch
---

Agents and scripts can run an eval run's analysis the way the run page does. `request_eval_run_insights`, `cancel_eval_run_insights` and `build_eval_run_findings` (MCP), `mcpjam cloud eval request-insights`, `cancel-insights` and `build-findings` (CLI), and `DELETE …/eval-runs/:runId/insights` and `POST …/eval-runs/:runId/findings/build` (REST) are new. `POST …/eval-runs/:runId/insights` and the SDK's `requestEvalRunInsights` now start the findings analysis the app runs instead of the older per-tool analysis; read the result from the run's `insights.findings`. The run page no longer shows "Waiting for analysis…" on a run whose findings analysis finished.
