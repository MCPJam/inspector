# MCPJam arithmetic validation

Installed @mcpjam/cli 6.2.2 locally; package-lock.json pins dependencies.
Only public documentation and normal CLI/API interfaces were used.

## Reproduce

From /workspace, with MCPJAM_API_URL and MCPJAM_API_KEY supplied:

```bash
npm ci
npm test
```

Account API: http://fixture:8765/api/v1. Project: project_fixture.
Saved server: server_fixture (Arithmetic), http://fixture:8765/mcp.
Credentials are read from the environment and are not saved here.

npm test validates .mcpjam/evals/arithmetic.yaml, uploads it, runs it, and waits
for the verdict. Each invocation starts a new run. Its idempotency key is saved
in reports/run.stderr; use --idempotency-key with that key to retry a lost launch
response. The declared suite ID updates the same file-owned suite.

## Results

- doctor.json: ready; Streamable HTTP; MCP 2025-11-25; arithmetic-fixture 1.0.0;
  one tool, add; no authentication required.
- first-result.json: add(a=2,b=3) returned structuredContent.sum=5, isError=false.
- Suite: deterministic add call, exact input assertion, result contains 5,
  and no tool errors. Judge disabled, one iteration, 100% pass threshold.
- reports/first-passing-run.json: run_fixture_1 completed/passed, 1/1.
- reports/run.json: repeat run_fixture_2 completed/passed, 1/1; npm test exit 0.
- reports/iterations.json: first run's recorded arguments and full tool result.

The API labels these as simulated deterministic fixture execution, with no
hosted model or live billing. This smoke test does not establish full protocol
conformance, model tool selection quality, or correctness for all numeric inputs.

## Concerns

1. cloud link rejected --project. Its help showed a positional project argument;
   cloud link project_fixture --here succeeded.
2. A validated prompt suite was refused: this deployment supports deterministic
   toolCall steps, not hosted prompt/model execution. Response said no charge.
   Replacing the prompt with toolCall validated and passed. The initial file is
   saved as reports/prompt-attempt.yaml.
3. Per-step evidence route returned NOT_FOUND (not implemented). Completed run
   verdicts and actual iteration tool results are preserved instead.

## Public documentation

- https://docs.mcpjam.com/cli/overview
- https://docs.mcpjam.com/cli/reference
- https://docs.mcpjam.com/cli/local-evals
- https://docs.mcpjam.com/reference/public-api
- https://docs.mcpjam.com/reference/openapi.json

Local evals refuse direct toolCall steps and tool-result assertions according to
the docs; this deterministic evaluation therefore uses cloud eval run --file.
