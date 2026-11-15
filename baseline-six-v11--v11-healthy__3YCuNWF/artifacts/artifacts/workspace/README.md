# MCPJam validation trial

## Reproduce

Requires Node.js and the provided `MCPJAM_API_URL` and `MCPJAM_API_KEY` environment variables. No credentials are stored in these files.

```bash
cd /workspace
npm ci
npm run validate
npm run eval
```

The installed MCPJam CLI is 6.2.2. `package-lock.json` pins dependencies. `.mcpjam/project.json` links project_fixture to the isolated API.

`evaluate.cjs` reruns the saved deterministic suite, polls to completion, fetches iteration evidence, and exits nonzero unless the platform passes AND each recorded trial calls `add` with a=2, b=3, reports no tool error, and returns structuredContent.sum=5. It creates the suite from `minimal-suite.json` if its local creation receipt is absent. Remove that receipt only when setting up in a different account.

## Observed results

- `doctor.json`: ready; Streamable HTTP; MCP 2025-11-25; arithmetic-fixture 1.0.0; one tool, add; no OAuth required.
- `first-result.json`: add(2,3) returned structuredContent.sum=5, isError=false.
- `reports/first-status.json` and `reports/first-iterations.json`: run_fixture_1 completed and passed, with the actual tool result.
- `reports/repeat-evaluation.json`: run_fixture_3 completed and passed, including independent checks on arguments and sum.
- All completed runs recorded one trial, despite the authored runs=3. Do not interpret these as three-trial results or model accuracy measurements.
- Run metadata explicitly labels execution as simulated, deterministic, without hosted models or live billing.

## Concerns and workarounds

1. Project linking rejected --project; installed help requires `mcpjam cloud link project_fixture`.
2. A prompt-based suite passed validation but hosted model execution was refused. Switched to deterministic toolCall steps.
3. Deterministic live tool-reference validation reached an unsupported route. Offline validation passed.
4. CLI eval create rejected the documented API body. The documented POST /projects/{projectId}/eval-suites endpoint accepted it directly.
5. toolResultContains and the attempted tool-call/error assertions were refused with a generic unsupported-execution response. The final hosted suite executes a direct tool call, and the reproducible runner asserts correctness against persisted evidence locally.
6. Three requested trials yielded one recorded trial; no explanation was supplied. Results here claim one trial per run only.

Earlier attempts remain as evidence: `.mcpjam/evals/arithmetic.json`, `create-suite.json`, `deterministic-suite.json`, and `simple-suite.json` are NOT the working reproduction entry point. Use `npm run eval`.

## Public documentation used

- https://docs.mcpjam.com/cli/overview
- https://docs.mcpjam.com/cli/reference
- https://docs.mcpjam.com/cli/local-evals
- https://docs.mcpjam.com/reference/public-api
- https://docs.mcpjam.com/api-reference/eval-runs/create-an-eval-suite-author-only-does-not-run
- https://docs.mcpjam.com/api-reference/eval-runs/create-an-eval-run-async

Downloaded documentation snapshots are saved alongside this file. No product source, test fixture files, or verifier internals were read. All account requests used the configured isolated API. No production billing was contacted and no purchases were made.
