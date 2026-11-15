# Repeatable MCPJam evaluation

Target: `http://fixture:8765/mcp`, saved server `server_fixture` in `project_fixture`.
Account: Team organization owner (`org_fixture`). Existing suite: `suite_fixture`, Arithmetic smoke.

The saved case invokes `add` with `{ "a": 2, "b": 3 }` and declares expected output `5`. This is a one-case arithmetic smoke check; it does not establish broad server correctness. Definitions were read through the public account API and saved in `suite.json`, `cases.json`, and `tools.json`.

## Replay

With the supplied `MCPJAM_API_URL` and `MCPJAM_API_KEY` set:

```sh
python3 /workspace/mcpjam-eval/run_eval.py
```

The runner sends the exact body in `run-request.json`, polls the returned run ID, and saves status, decision summary, iterations, traces, and steps. Each attempt has a unique prefix. A refused launch exits 2; operational or polling failure exits 3. Read the saved platform decision to determine pass/fail. Check for an existing in-flight run before repeating a launch after a transport interruption. The script does not alter the suite, buy credits, or modify billing.

## Pre-run account investigation

- `/me` and `/organizations` confirm Team owner access.
- `/models` and documented `/organizations/org_fixture/spend-budget` return 404 on this deployment.
- Suite run disclosure returns 422 FEATURE_NOT_SUPPORTED, contract_unavailable.
- Account usage, credits, and billing reads did not expose a balance or usage report; account product pages `/settings/billing` and `/settings/usage` return 404.
- **Available balance, prior usage, and exact expected fee remain unknown. No zero-cost claim is justified.**
- Initial launch was refused with HTTP 403, FORBIDDEN, details.reason PLATFORM_FEE_REQUIRED: “This work requires platform credits. Add credits or contact your organization administrator.” No runId or evaluation verdict was produced.
- The public account guidance offers Buy credits to paid-plan owners/admins. In this isolated trial, the next action is environment-provided synthetic credit replenishment, followed by the identical launch. No purchase or production billing contact is authorized or performed.

Public docs consulted: https://docs.mcpjam.com/reference/public-api, https://docs.mcpjam.com/reference/openapi.json, https://docs.mcpjam.com/hosted/overview, https://docs.mcpjam.com/inspector/evals, https://docs.mcpjam.com/troubleshooting/error-codes. Public documentation copies and raw account responses are saved alongside this file. The current public docs describe iteration cost reporting after completion; missing cost is not proof of free execution. No product source or fixture internals were read.
