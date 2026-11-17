---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
"@mcpjam/inspector": patch
---

Agents and scripts can run an eval run's analysis the way the run page does. `request_eval_run_insights`, `cancel_eval_run_insights` and `build_eval_run_findings` (MCP), `mcpjam cloud eval request-insights`, `cancel-insights` and `build-findings` (CLI), and `DELETE …/eval-runs/:runId/insights` and `POST …/eval-runs/:runId/findings/build` (REST) are new. `POST …/eval-runs/:runId/insights` and the SDK's `requestEvalRunInsights` now start the findings analysis the app runs instead of the older per-tool analysis; read the result from the run's `insights.currentFindings`. Because the findings analysis explains a run's findings, such a request now answers 409 on a run whose findings are not built yet or are being rebuilt, where it used to start the older analysis; build them first with `build_eval_run_findings` or `mcpjam cloud eval build-findings`. The run page no longer shows "Waiting for analysis…" on a run whose findings analysis finished.
