---
"@mcpjam/sdk": minor
---

`run_eval_suite` no longer guesses a server default client-side: when `servers` is omitted, the request omits `serverIds` and the platform connects the suite's saved server selection — the exact set the run snapshot references (the previous all-enabled-HTTP default could miss it and fail the run after the 202). The resolved set comes back in the result, and `PlatformEvalRunCreated` gains the matching optional `servers` field. Explicit `servers` overrides keep their client-side resolution and validation. Requires a platform deployment where `POST /eval-runs` accepts rerun bodies without `serverIds`; older deployments answer with an actionable `VALIDATION_ERROR`.
