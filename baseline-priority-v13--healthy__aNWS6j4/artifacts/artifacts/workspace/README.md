# MCPJam arithmetic validation

Installed from npm in a clean Node.js environment. Dependencies are pinned by package-lock.json.

## Reproduce

Keep MCPJAM_API_URL and MCPJAM_API_KEY set to this isolated account.

```sh
npm ci
npm run eval
```

The script validates the versioned suite against project_fixture, runs it to completion, and writes artifacts/eval-report.json. A completed passing run exits 0; a measured evaluation failure exits 1. Each invocation starts a new run. If a launch response is lost, use its recorded idempotency key from artifacts/run.stderr to retry that launch rather than starting another.

## Evidence

- artifacts/doctor.json: Streamable HTTP connection ready; arithmetic-fixture 1.0.0 exposes add with numeric a and b.
- artifacts/add.json: direct call add(2,3) returned structuredContent.sum = 5 and isError = false.
- .mcpjam/evals/arithmetic.json: direct tool call followed by toolResultContains requiring the full text fragment {"sum": 5}. This is a text-content assertion, not structural equality.
- artifacts/eval-report.json: latest completed passing run, run_fixture_4.
- artifacts/negative-report.json: wrong-answer control requiring {"sum": 999} failed, with CLI exit 1.
- artifacts/iterations.json: initial run's recorded tool arguments and result.

The isolated service labels these runs SIMULATED: deterministic fixture execution; no hosted model or live billing. This checks the authored tool case and assertion path; it does not establish LLM tool-selection accuracy or full MCP protocol conformance.

## Setup concerns resolved

Cloud servers are listed through mcpjam cloud projects servers, rather than cloud servers. Schema version 2 requires mode agentWorkflow and a model field even for this direct tool case. The platform refused toolResultMatchesSchema as outside its supported subset; toolResultContains succeeded. The local runner documentation says direct toolCall steps and gating tool-result assertions require the hosted runner, so this workflow uses cloud eval run.

## Public documentation

- https://docs.mcpjam.com/cli/overview
- https://docs.mcpjam.com/cli/local-evals
- https://docs.mcpjam.com/cli/reference
- https://docs.mcpjam.com/api-reference/eval-runs/create-an-eval-case

Downloaded public documentation snapshots are in docs/ and docs-index.txt. No credentials are stored in these artifacts.
