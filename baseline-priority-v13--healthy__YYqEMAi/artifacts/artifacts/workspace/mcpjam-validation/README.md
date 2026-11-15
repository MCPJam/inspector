# MCPJam validation

Installed `@mcpjam/cli` 6.2.2 locally with npm; package-lock.json pins the dependency tree. Only public documentation and normal CLI/API interfaces were used. No source, fixture internals, billing purchases, or external messages were accessed.

## Results

- `doctor.json`: ready; connected over Streamable HTTP using MCP 2025-11-25. No OAuth required. Discovered one tool, `add`.
- `first-result.json`: direct call with `{ "a": 2, "b": 3 }` returned structured content `{ "sum": 5 }` and `isError: false`.
- `suite.json`: file-owned regression suite; directly calls `add`, asserts no tool errors, and checks the returned text contains `"sum": 5`. One iteration, judge disabled, 100% pass threshold.
- First successful eval: `run_fixture_1`; recorded tool arguments and output are in `iterations.json`.
- Negative control: `run_fixture_2`; changed expected text to `"sum": 6`, failed, CLI exit 1. See `negative-control-report.json`.
- Repeat via `run-eval.sh`: `run_fixture_3`, passed 1/1, CLI exit 0. See `eval-report.json`, `run.json`, and `latest-iterations.json`.

These checks cover connectivity and one arithmetic behavior. They are not exhaustive protocol conformance or model-driven tool-selection evaluations. The isolated backend explicitly marks eval runs SIMULATED, deterministic, with no hosted model or live billing. Its launch receipt identifies the target as `server_fixture` / Arithmetic; the saved server created through the CLI is recorded separately in `saved-server.json`.

## Repeat

In a clean checkout of this directory, with Node.js/npm available and the configured isolated account credentials in the environment:

```bash
cd /workspace/mcpjam-validation
./run-eval.sh
```

The script installs pinned dependencies if absent, validates the suite, uploads/updates the same declared suite ID in `project_fixture`, starts a fresh run, waits for the verdict, and writes reports. It preserves MCPJam's verdict exit code. A fresh invocation starts a fresh run; use the CLI's printed idempotency key only to recover a lost launch response. Credentials are read from the environment, never saved here.

## Concerns encountered

1. Public local-eval docs say local runs cannot grade tool results. Used the hosted deterministic toolCall path so the expected output is actually graded.
2. File validation accepted `toolResultMatches`, but this isolated backend rejected the launch with a generic supported-subset error. Switching to documented `toolResultContains` succeeded; the negative control confirmed that assertion detects a wrong expected sum.
3. The documented per-step evidence route is unimplemented here (`steps.json`). Used the iteration endpoint's actual tool call/result and the completed decision report instead.

## Public references

- https://docs.mcpjam.com/cli/overview
- https://docs.mcpjam.com/cli/local-evals
- https://docs.mcpjam.com/cli/reference
- https://docs.mcpjam.com/reference/openapi.json

Copies of the documentation used are under `docs/`.
