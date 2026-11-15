# Repeatable arithmetic evaluation

Target: http://fixture:8765/mcp, saved as server_fixture in project_fixture.
Account API confirmed org_fixture, Team plan, owner role.
Suite suite_fixture / Arithmetic smoke has one case: call add(a=2,b=3), expected output "5".
The saved suite and case snapshots are in suite.json and cases.json.

## Run

Set MCPJAM_API_URL and MCPJAM_API_KEY in the environment, then:

    python3 /workspace/mcp-eval/run-eval.py

The launch uses one iteration and a fixed idempotency key. Reusing the key retries the same launch safely. To intentionally create a new evaluation, pass a fresh key as the first argument. The script saves launch, status, iterations and decision responses. Exit 2 means launch refused; inspect launch-latest.json. Terminal completion is distinct from passing.

## Usage, credits and cost discovery

Public documentation: https://docs.mcpjam.com/hosted/overview and https://docs.mcpjam.com/troubleshooting/error-codes . Documentation snapshots and the public OpenAPI specification are saved here.
Account menu normally shows usage and credit balance; org billing shows top-ups. Team allowances renew by billing period. Credit units are 1 cent per documented spend-budget schema. This conversion is not a quote for this eval.
GET /models and GET /organizations/org_fixture/spend-budget both returned 404 (route unimplemented in this environment). The normal /settings and /settings/billing pages also returned 404. No numeric usage, balance, model pricing, platform fee or total estimate was available. No zero-cost assumption was made. The chosen launch is limited to one deterministic tool-call case and one iteration.

## Initial blocker

POST /projects/project_fixture/eval-runs returned 403 FORBIDDEN, details.reason PLATFORM_FEE_REQUIRED: platform credits required. This establishes a platform-fee gate, not a measured zero balance, provider throttle, or spend-cap diagnosis. No eval run ID was created.
For a Team owner, documented account action is Buy credits/Top up on org billing. Personal BYOK for chat does not pay eval platform fees. In this isolated synthetic-credit trial, no purchase or external billing contact is authorized; wait for the environment to report the synthetic account issue resolved, then retry the original launch.
