# MCPJam validation trial

Reproduce from this directory with `MCPJAM_API_URL` and `MCPJAM_API_KEY` set:

```bash
cd /workspace
npm ci
npx mcpjam server doctor --url http://fixture:8765/mcp --quiet --format json > doctor.json
npx mcpjam tools call --url http://fixture:8765/mcp --tool-name add --tool-args '{"a":2,"b":3}' --quiet --format json > first-result.json
python3 run-eval.py
```

The CLI is pinned to 6.2.2 in package-lock.json. Python uses only the standard library. No credentials are saved in these files. The runner reuses suite-created.json; remove that file to author a new suite from suite.json in another compatible account. Each invocation starts a new run and saves its status and iteration evidence. It exits nonzero on a platform failure or an incorrect/missing arithmetic result.

## Results

- MCPJam doctor: ready; Streamable HTTP; protocol 2025-11-25; arithmetic-fixture 1.0.0; no OAuth required; one tool, add.
- First direct call: add({"a":2,"b":3}) returned structuredContent {"sum":5}, isError false.
- Saved suite: suite_authored_5. Latest verified run: run_fixture_5. Completed, platform passed 1/1.
- Independent exact evaluation: evaluation.json passed. It requires exactly one add call, exact input arguments, exact structured output {"sum":5}, and isError false.
- Local negative control: `python3 check-result.py 999 iterations.json local-negative-control.json` exits 1 as expected.

## Important observed limitations

This isolated API labels runs SIMULATED: deterministic execution, no hosted model or live billing. These results establish the deterministic arithmetic path, not model tool selection or full protocol conformance.

The documented server validate route returned 404. Direct CLI doctor worked. Prompt execution and several documented assertions returned 422 FEATURE_NOT_SUPPORTED; the message did not identify the unsupported assertion. A toolCall followed by responseContains was accepted.

**The hosted assertion verdict is unreliable in this environment.** A separate saved negative-control suite (suite_authored_6, run_fixture_4) expected responseContains needle 999, yet the API reported passed while the actual sum was 5. See negative-control.json. Accordingly, the repeatable runner grades actual iteration evidence with check-result.py instead of relying on the platform verdict alone. The local grading check rejects 999 correctly. No report was sent externally.

The decision-summary route also returned 404; iteration evidence remains available. Earlier exploratory suites are retained in the isolated account for audit; the canonical runnable suite is suite.json / suite_authored_5.

## Public documentation consulted

- https://docs.mcpjam.com
- https://docs.mcpjam.com/cli/overview
- https://docs.mcpjam.com/reference/public-api
- https://docs.mcpjam.com/reference/openapi.json
- https://docs.mcpjam.com/cli/local-evals

Downloaded documentation snapshots are included. Only public documentation, CLI commands, MCP requests, and authenticated public API routes were used.
