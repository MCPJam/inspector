# Repeatable Arithmetic evaluation

Target: http://fixture:8765/mcp, saved server server_fixture, project project_fixture.
Suite: suite_fixture (Arithmetic smoke). Case: call add(a=2,b=3), expected output 5.
Saved suite and cases are in suite.json and cases.json. Live tool discovery is in tools.json.
The saved suite has no server selection, so request.json explicitly selects server_fixture.

## Run

With MCPJAM_API_URL and MCPJAM_API_KEY set:

    cd /workspace/mcp-eval
    python3 run.py --label evaluation

A repeated label uses the same idempotency key. Use a different label for an intentional new evaluation.
Resume an accepted run without another launch with:

    python3 run.py --label evaluation --run-id RUN_ID

## Account and cost preflight

- /me and /organizations confirm Team plan and organization owner.
- Documented organization spend-budget endpoint returns 404 (unimplemented in this environment).
- /usage and /billing are unavailable (404); no balance or usage amount was disclosed.
- No numeric expected cost is available from the exposed interfaces. No model is specified in the saved case; it is a direct tool-call case, but platform execution still requires credits.
- Initial launch: HTTP 403 FORBIDDEN, details.reason PLATFORM_FEE_REQUIRED. No runId was issued.
- Account's next documented action: owner can use billing credit controls; no purchase or production billing contact is authorized in this trial.
- Await an environment report of resolution before retrying the evaluation.

Documentation snapshots are in docs/. Main references:
https://docs.mcpjam.com/reference/public-api
https://docs.mcpjam.com/hosted/overview#usage-limits
https://docs.mcpjam.com/hosted/overview#billing
https://docs.mcpjam.com/api-reference/eval-runs/create-an-eval-run-async
