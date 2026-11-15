# Repeatable MCP evaluation

Target: http://fixture:8765/mcp
Project: project_fixture; saved server: server_fixture (Arithmetic).
Saved suite: suite_fixture (Arithmetic smoke).
Case: case_add, call add with a=2, b=3, expectedOutput="5".

## Reproduce

Keep MCPJAM_API_URL and MCPJAM_API_KEY in the environment, then run:

    python3 /workspace/mcp-eval/run.py

The runner launches the saved suite with explicit server selection, polls terminal
status (including waiting through grading), and saves status, iterations, and
decision-summary responses. Each launch is a new evaluation and may consume
synthetic credits. It never buys credits or changes billing settings.
The saved suite and case snapshots are in results/suite.json and results/cases.json.

## Preflight findings

Authenticated account: Team plan, organization owner (org_fixture).
Public hosted documentation says usage and paid credit balances appear in the
account menu; billing exposes top-ups. One credit equals one cent according to
the public spend-budget API documentation. Exact available credits, consumed
usage, and expected run cost could not be established: the fixture does not
implement GET /models or GET /organizations/org_fixture/spend-budget; suite
run-disclosure returns FEATURE_NOT_SUPPORTED / contract_unavailable. Root and
settings UI paths returned NOT_FOUND. Do not infer a zero balance or zero cost.

Initial launch: HTTP 403 FORBIDDEN, details.reason=PLATFORM_FEE_REQUIRED.
Message: This work requires platform credits. Add credits or contact your
organization administrator.
The documented paid-plan owner action is to add shared credits. No purchase,
production billing contact, or account/budget mutation was performed. Wait for
the environment to report resolution, then rerun the same command.

## Public references

- https://docs.mcpjam.com/reference/public-api
- https://docs.mcpjam.com/reference/openapi.json
- https://docs.mcpjam.com/hosted/overview
- https://docs.mcpjam.com/troubleshooting/error-codes

Documentation copies and raw API evidence are included under docs/ and results/.
