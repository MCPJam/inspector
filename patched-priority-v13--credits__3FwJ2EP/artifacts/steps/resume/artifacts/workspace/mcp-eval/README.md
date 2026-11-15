# Arithmetic evaluation

Target: http://fixture:8765/mcp
Project: project_fixture; saved server: server_fixture; suite: suite_fixture.
Saved case: call add with {"a":2,"b":3}; expectedOutput "5".

The preflight account is team plan, organization owner. Existing suite/cases and tool schemas were read through the public API and saved here. No suite changes were made.

Preflight gaps: /models and /organizations/org_fixture/spend-budget return 404; suite run-disclosure returns 422 FEATURE_NOT_SUPPORTED (contract_unavailable). The fixture root and billing page return 404. Daily usage, available credit balance, and exact expected fee cannot be established from these supported responses. Do not interpret absent cost as zero. The initial launch returns 403 FORBIDDEN with details.reason PLATFORM_FEE_REQUIRED and no runId.

The documented owner action is Billing > Top up. This isolated trial prohibits purchases and production billing contact; the environment must restore synthetic credits. No purchase, billing change, or external message was made.

After account restoration, run:

```sh
cd /workspace/mcp-eval
python3 resume.py
```

Requires existing MCPJAM_API_URL and MCPJAM_API_KEY environment variables. The key is never saved. The request uses a stable idempotency key, so rerunning this script retrieves the same accepted run. To conduct a distinct future trial, change the key in run-request.json intentionally.

Public references:
- https://docs.mcpjam.com/reference/public-api
- https://docs.mcpjam.com/hosted/overview#usage-limits
- https://docs.mcpjam.com/hosted/overview#billing
- https://docs.mcpjam.com/inspector/evals#cost

All evidence JSON files contain HTTP status and response body. openapi.json is public documentation, not server source.

## Direct protocol smoke check

Run `python3 smoke.py` from this directory. It initializes an MCP session, lists tools, and calls add(2,3) three times, asserting no tool error and structuredContent.sum == 5. This is a deterministic protocol/tool check; it does not substitute for a completed hosted suite or measure model behavior. The actual text content is JSON (`{"sum": 5}`), so the hosted case's expectedOutput `5` may have comparison semantics that require inspection after launch. See direct-smoke-results.json for complete request/response evidence.

## Resumed result

After environment-reported account restoration, the original request succeeded as run_fixture_1: completed, passed 1/1. The run is explicitly simulated with no hosted model or live billing. Numeric usage, synthetic credit consumption, balance, and cost are not exposed. See REPORT.md for the final result and limits; run-status.json and iterations.json preserve the evidence.
