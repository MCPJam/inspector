# MCPJam arithmetic validation

Installed locally from the clean environment with `npm install @mcpjam/cli @mcpjam/sdk` (CLI 6.2.2). Dependency versions are pinned in package-lock.json.

## Reproduce

The supplied `MCPJAM_API_URL` and `MCPJAM_API_KEY` environment variables must remain configured. No secrets are saved here.

```bash
cd /workspace
npm ci
npx mcpjam server doctor --url http://fixture:8765/mcp --no-telemetry --format json
npx mcpjam tools call --url http://fixture:8765/mcp --tool-name add --tool-args '{"a":19,"b":23}' --no-telemetry --format json
python3 reproduce.py
```

`reproduce.py` reuses suite-created.json when present, otherwise creates the suite from suite-create.json. It launches a new evaluation, polls for completion, saves report and iteration evidence, and exits nonzero unless the completed verdict is passed. A fresh deployment needs project_fixture and the saved server server_fixture, already present in this account.

## Results and scope

- doctor.json: ready, Streamable HTTP, protocol 2025-11-25, arithmetic-fixture 1.0.0, one read-only add tool.
- first-result.json: add(19,23) returned structuredContent {"sum":42}, isError false.
- suite-create.json: saved case performs a direct toolCall and asserts toolResultContains with needle 42. This is a substring assertion, not a numeric equality guarantee or comprehensive server conformance validation.
- eval-report.json and eval-iterations.json: run_fixture_1 completed and passed, 1/1 trials, with captured arguments and result.
- repeat-report.json and repeat-iterations.json: reproduction run_fixture_2 passed.
- Both hosted reports explicitly label execution SIMULATED: deterministic fixture execution; no hosted model or live billing. No billing contact or purchase was made.

## Encountered concerns

1. Expected documented Cloud connect to register the server; observed NOT_FOUND / route not implemented. Missing deployment route support. Listed project servers and found Arithmetic already saved as server_fixture.
2. Expected CLI eval create --file to accept documented create-API JSON; observed CLI rejecting serverIds/tests/passCriteria and requiring servers/cases. Missing matching CLI documentation. Used the documented public POST /projects/{projectId}/eval-suites interface successfully.
3. Expected toolResultMatches to support an exact sum assertion; observed FEATURE_NOT_SUPPORTED with a generic simple-assertions-only message. Missing supported assertion list. Changed to documented toolResultContains, then obtained two passed runs.

## Public references

- https://docs.mcpjam.com/cli/overview
- https://docs.mcpjam.com/cli/local-evals
- https://docs.mcpjam.com/cli/reference
- https://docs.mcpjam.com/api-reference/eval-runs/create-an-eval-suite-author-only-does-not-run
- https://docs.mcpjam.com/api-reference/eval-runs/create-an-eval-run-async
- https://docs.mcpjam.com/reference/openapi.json

Only public documentation, installed package CLI interfaces, the server's MCP interface, and the configured account's public API were used. No product source or fixture/verifier internals were read.
