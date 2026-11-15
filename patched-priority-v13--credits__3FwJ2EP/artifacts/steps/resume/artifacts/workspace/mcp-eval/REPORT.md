# Evaluation result

After the environment reported account resolution, the original saved request was resumed unchanged with its original idempotency key.

- Run: run_fixture_1; suite: suite_fixture; project: project_fixture.
- Launch accepted: HTTP 202. Final status: completed; result: passed.
- Total: 1 iteration; passed: 1; failed: 0; pass rate: 100%.
- Actual tool call: add({"a":2,"b":3}).
- Actual output: structuredContent.sum = 5; text content = {"sum": 5}; isError = false.
- Reported iteration duration: 1 ms.

The run explicitly states: "SIMULATED: deterministic fixture execution; no hosted model or live billing." This validates the fixture's deterministic case and resumed launch flow. It does not measure hosted model behavior, real billing, or statistical reliability. The earlier direct MCP smoke check passed the same arithmetic operation 3/3 times.

## Usage, credits, and cost

Before the first launch, the account was confirmed as team plan and organization owner. Available credit balance, daily usage, and exact expected fee were not exposed: model catalog and spend-budget routes returned 404, and run-disclosure returned 422 FEATURE_NOT_SUPPORTED. The first launch returned 403 PLATFORM_FEE_REQUIRED with no run ID. The documented owner action was Billing > Top up; this trial prohibited purchases, so no billing changes or production contacts were made.

After environment-reported restoration, launch succeeded. The run and iteration contain no token usage, cost, rate, or credit balance fields. The spend-budget route still returns 404. Iteration trace, step results, and decision summary also return 404. Therefore numeric credit consumption and available balance remain unknown. The explicit simulation note confirms no live billing; it does not establish a production cost estimate or a synthetic credit debit amount.

## Reproduce

With MCPJAM_API_URL and MCPJAM_API_KEY set:

```sh
cd /workspace/mcp-eval
python3 resume.py
python3 smoke.py
```

resume.py submits run-request.json with a stable idempotency key, polls status, and saves iterations. Reusing this key retrieves the same accepted run; a distinct future evaluation needs an intentional new key. smoke.py independently initializes MCP, lists tools, and checks three tool responses. Neither script embeds credentials.

Evidence: launch-01.json (original refusal), launch-resumed.json (accepted launch), run-status.json (completed verdict), iterations.json (actual call/output), direct-smoke-results.json (three direct calls), and account/preflight response files.

Public documentation consulted:
- https://docs.mcpjam.com/reference/public-api
- https://docs.mcpjam.com/hosted/overview#usage-limits
- https://docs.mcpjam.com/hosted/overview#billing
- https://docs.mcpjam.com/inspector/evals#cost
