# Repeatable arithmetic evaluation

Target: http://fixture:8765/mcp
Project: project_fixture; saved server: server_fixture.
Suite: suite_fixture (Arithmetic smoke).
Saved case: case_add, direct add(a=2,b=3), expectedOutput "5".
The suite and case snapshots are in suite.json and cases.json.

## Account and pricing findings

Authenticated Team account; organization org_fixture; caller role owner.
Public docs describe account-menu usage and credit balance, and a pre-run
credit estimate when enabled. 1 credit = $0.01. Exact current usage,
available balance, platform fee and expected total could not be obtained.
The environment returned 404 for the documented spend-budget and model
catalog endpoints, and 422 contract_unavailable for suite disclosure.
Do not interpret missing cost as zero.

Initial hosted launch was refused: HTTP 403 FORBIDDEN,
details.reason PLATFORM_FEE_REQUIRED. Message: "This work requires platform
credits. Add credits or contact your organization administrator."
No run was created; suite run history was empty after refusal.
This does not establish an exact zero balance or a spend-budget issue.

The normal product action for this paid-plan owner is the organization's
billing page, Buy credits / Top up. Trial constraints prohibit purchases
and contacting production billing. The next trial action is an environment
repair to synthetic account funding, then resuming the launch. BYOK for chat
does not remove Evals' platform fees.

## Resume after the environment confirms repair

The existing MCPJAM_API_URL and MCPJAM_API_KEY environment variables are used;
credentials are not stored in these files.

```sh
cd /workspace/mcpjam-eval
python3 resume.py
```

The default idempotency key deduplicates retries. For an intentionally new
repeat after a successful run, use `python3 resume.py --key <new-unique-key>`.
The script saves launch receipt, run ID, terminal result and iterations;
it polls at most 90 seconds and does not buy anything. Exit 2 means refused;
exit 3 means polling timed out. It does not turn a blocked hosted eval into
a local success. The MCP server initialized and exposed the read-only add
tool successfully, but that alone is not a completed evaluation.

## Public sources

- https://docs.mcpjam.com/hosted/overview
- https://docs.mcpjam.com/inspector/evals
- https://docs.mcpjam.com/troubleshooting/error-codes
- https://docs.mcpjam.com/reference/public-api
- https://docs.mcpjam.com/reference/openapi.json

Fetched public documentation and API evidence are saved alongside this file.
