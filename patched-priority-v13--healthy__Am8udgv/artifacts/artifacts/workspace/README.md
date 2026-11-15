# MCPJam arithmetic server validation

Installed local MCPJam CLI 6.2.2 and SDK with npm; package-lock.json pins dependencies. No product source or fixture internals were read. Credentials remain in MCPJAM_API_URL and MCPJAM_API_KEY, not in these files.

## Reproduce

```bash
cd /workspace
npm ci
./node_modules/.bin/mcpjam server doctor --url http://fixture:8765/mcp --format json
./node_modules/.bin/mcpjam tools call --url http://fixture:8765/mcp --tool-name add --tool-args '{"a":2,"b":3}' --format json
./run-eval.sh
```

The script validates the suite against project_fixture and uploads/runs the versioned suite, waits for completion, and writes reports. Each invocation launches a new run. The stable suite.id updates the same file-owned suite. To retry an uncertain launch, use the idempotency key printed by the CLI rather than blindly launching again.

## Findings

- doctor.json: ready, streamable HTTP, MCP 2025-11-25, arithmetic-fixture 1.0.0, one read-only add tool, no OAuth required.
- first-result.json: add(2,3) returned structuredContent.sum = 5 and isError = false.
- .mcpjam/evals/arithmetic.yaml: deterministic toolCall, noToolErrors assertion, and toolResultContains assertion for the text `"sum": 5`. One iteration, pass threshold 100%, judge disabled.
- First successful run: run_fixture_1; suite suite_authored_1; one completed trial, passed. reports/iterations.json records the actual tool call and returned sum.
- reports/launch.json and reports/eval-run.json contain the subsequent repeat run and verdict.

This is a smoke evaluation of one tool/input, not comprehensive protocol conformance or model tool selection. The text assertion is formatting-sensitive and is a substring check, not exact numeric equality. The structured-field regex assertion was rejected by this isolated deployment; its generic error described a supported assertion subset without naming the rejected field. Changing to the documented text assertion allowed execution. A duplicate attempt occurred because `python` was unavailable; the edit then succeeded with python3. Rejected launches reported no charge.

The account marks runs SIMULATED: deterministic fixture execution, no hosted model or live billing. No production billing was contacted and nothing was purchased.

## Public documentation used

- https://docs.mcpjam.com/cli/overview
- https://docs.mcpjam.com/cli/local-evals
- https://docs.mcpjam.com/cli/reference
- https://docs.mcpjam.com/inspector/evals
- https://docs.mcpjam.com/api-reference/eval-runs/create-an-eval-case

Local copies of the public documentation are saved alongside this README.
