---
"@mcpjam/sdk": minor
---

`PlatformEvalRunSummary` carries the run's `result`

The API has been returning a verdict on every latest-run summary
(`GET /v1/eval-suites` → `latestRun.result`); the SDK type did not declare it,
so every consumer of that summary was left re-deriving a verdict from
`passed`/`failed`. No derivation over counts can produce `inconclusive`, so
that re-derivation turned "the platform could not measure this run" into a
pass or a failure it explicitly declined to declare.

Additive and optional — absent on API deployments that predate the field.

This also fixes the MCP eval widget (`@mcpjam/mcp`, unpublished), where an
inconclusive run rendered as a green "Completed" dot behind
`list_eval_suites`, `list_eval_suite_runs` and `get_eval_run`.
