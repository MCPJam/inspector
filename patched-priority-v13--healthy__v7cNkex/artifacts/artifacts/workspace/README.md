# MCPJam validation

Installed @mcpjam/cli 6.2.2 locally; package-lock.json pins the installation.

## Repeat

From /workspace, with MCPJAM_API_URL and MCPJAM_API_KEY configured:

```bash
npm ci
./node_modules/.bin/mcpjam server doctor --url http://fixture:8765/mcp --no-telemetry --format json
./node_modules/.bin/mcpjam tools call --url http://fixture:8765/mcp --tool-name add --tool-args '{"a":2,"b":3}' --no-telemetry --quiet --format json
node run-eval.mjs
```

`node run-eval.mjs --create` authors a fresh suite from suite.json before running it. Without --create, it reruns the suite ID in suite-created.json. The script polls to completion, saves run and iteration evidence, and exits nonzero unless the platform reports completed/passed. Credentials are read from the environment and never saved.

## Evidence and scope

- doctor.json: ready, successful initialization over Streamable HTTP, protocol 2025-11-25, one add tool.
- first-result.json: direct add(2,3), structuredContent.sum = 5, isError false.
- suite.json: model-free deterministic toolCall with fixed arguments and assertions for no tool errors and the full returned JSON text {"sum": 5}. The text assertion intentionally follows this server's serialization; changing whitespace can fail it.
- suite-created.json: saved repeatable evaluation suite.
- first-eval-status.json and first-eval-iterations.json: first successful run of the final suite.
- run-status.json and iterations.json: latest rerun verdict and actual tool call evidence.

This establishes a narrow addition smoke check, not complete protocol conformance or model tool-selection quality. Run responses explicitly label execution SIMULATED, deterministic, with no hosted model or live billing.

## Deployment restrictions observed

Hosted prompt/model execution is refused with FEATURE_NOT_SUPPORTED / fixture_unsupported_execution. Keeping a suite model setting also caused rejection after replacing the prompt with toolCall. The accepted suite omits model, although the public create-suite schema marks it required. The documented decision-summary endpoint returned 404; run status and iterations supplied the verdict and evidence. Earlier unsuccessful payloads/responses are preserved with unsupported-* filenames. No production billing or purchase endpoint was contacted.

## Public documentation

- https://docs.mcpjam.com/cli/overview
- https://docs.mcpjam.com/reference/public-api
- https://docs.mcpjam.com/reference/openapi.json

The public OpenAPI defines deterministic EvalTestStep kind=toolCall, suite authoring, run creation, and run/iteration reads. Saved documentation snapshots are included alongside the scripts.
