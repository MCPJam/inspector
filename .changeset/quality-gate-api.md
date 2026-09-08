---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
"@mcpjam/inspector": minor
---

Expose the stored suite quality gate on PATCH and GET

**A stored policy had no public writer or reader.** `settings.qualityGate` now
rounds through the protected apply-settings core (reason + revision
required), and `GET …/eval-runs/:runId/gate` plus `get_eval_run_gate`
return the backend's `SuiteGateReportV1`. The CLI composes that unwaived
suite section after the existing flag waiver; `--no-suite-policy` skips
only the new call. A missing route is not proof the suite has no policy.
