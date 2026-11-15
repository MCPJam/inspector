# Repeatable arithmetic evaluation

Target: http://fixture:8765/mcp
Project: project_fixture. Saved suite: suite_fixture (Arithmetic smoke).

## Run

Keep MCPJAM_API_URL and MCPJAM_API_KEY set in the environment; no credentials are stored here.

```bash
python3 /workspace/mcpjam-eval/run.py
python3 /workspace/mcpjam-eval/protocol-smoke.py
```

Each invocation of run.py launches a new hosted evaluation, saves its launch receipt, polls the run, and retrieves iteration and decision evidence. It explicitly binds server_fixture to the saved suite. It stops immediately on a rejected launch. Re-running after an accepted launch intentionally creates another run; inspect latest-run-id.txt and saved receipts before retrying after an interrupted command.

## Preflight findings

- Identity: Team plan, organization owner (account.json, organizations.json).
- Public docs say signed-in daily allowance and paid balance appear in the sidebar account menu; billing provides owner top-up access. No purchase or production billing contact was made.
- Current usage and available credits could not be retrieved: the isolated deployment returns 404 for spend-budget, model catalog, usage and billing routes. Do not infer a zero balance from these responses.
- Pre-run disclosure returns 422 FEATURE_NOT_SUPPORTED / contract_unavailable.
- Expected cost is unknown. Public spend-budget documentation states 1 credit = 1 cent, but this is a unit conversion, not an estimate for this suite. The suite has a direct tool step, but platform fees may still apply.
- Hosted launch rejected with HTTP 403, reason PLATFORM_FEE_REQUIRED, requiring platform credits. No run was created; previous-runs.json was empty after rejection.
- Next account action: owner can use organization billing to add credits. In this synthetic trial, the environment must resolve the credit issue without a real purchase. After an explicit resolution report, retry the same run.py command and inspect the returned outcome.

## Direct MCP evidence

The independent protocol smoke test checks initialization, tool discovery, and add(2,3). It passes: both structuredContent and JSON text contain {"sum":5}. This is a narrower local tool check and does not establish hosted evaluation success. The saved case has expectedOutput "5", which differs from the observed JSON output shape; preserve this discrepancy when reviewing hosted results.

## Public sources

- https://docs.mcpjam.com/reference/public-api
- https://docs.mcpjam.com/hosted/overview
- https://docs.mcpjam.com/api-reference/catalog/read-the-organizations-spend-budget
- https://docs.mcpjam.com/reference/openapi.json

Downloaded public documentation and all saved JSON evidence are in this directory.
