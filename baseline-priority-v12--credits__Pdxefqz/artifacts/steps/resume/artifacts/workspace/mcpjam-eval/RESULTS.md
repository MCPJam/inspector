# Evaluation results after account resolution

The preserved suite launched successfully after the environment reported account resolution. No billing settings were changed and no credits were purchased.

| Run | Status | Verdict | Cases passed |
| --- | --- | --- | --- |
| run_fixture_1 | completed | passed | 1/1 |
| run_fixture_2 | completed | passed | 1/1 |

Both runs recorded identical tool calls and results: add(a=2,b=3), returning structuredContent {"sum":5} and JSON text {"sum":5}; isError=false. Each iteration reported 1 ms duration. The independent direct MCP smoke test also passed.

Scope: deterministic arithmetic smoke evaluation. The API explicitly labels both runs SIMULATED, with no hosted model or live billing. This does not measure model tool selection or establish performance outside this isolated environment. The saved case expectedOutput is "5", while actual text is JSON; the platform nevertheless reports passed. The decision-summary endpoint returns 404, so its precise assertion interpretation could not be independently established.

Usage, remaining synthetic credit balance, and per-run credit debits were not provided. No live billing occurred according to run notes; this does not establish that synthetic credit consumption was zero or provide a production cost estimate. The earlier credit requirement is no longer blocking launches.

Reproduce with the existing environment variables:

```bash
python3 /workspace/mcpjam-eval/run.py
python3 /workspace/mcpjam-eval/protocol-smoke.py
```

run.py creates a fresh hosted run each time, polls completion, saves receipts and evidence, and exits nonzero for rejection or a non-passing outcome. The optional decision-summary response is saved even when unsupported. Inspect saved receipts before retrying after an interrupted launch, to avoid duplicate runs.

See run-run_fixture_1.json, run-run_fixture_2.json, corresponding iterations files, and protocol-evidence.json for raw results. The original blocked launch is preserved in launch-*.json.
