# MCPJam validation — 2026-11-15

Target: `http://fixture:8765/mcp`, using existing `/workspace/mcp.json`.
Project: `project_fixture`; saved server: `server_fixture`.
CLI: `@mcpjam/cli@6.2.2`; negotiated/pinned protocol: `2025-11-25`.

## Confirmed

- CLI doctor: ready; Streamable HTTP initialization and tool discovery succeeded.
- Server identifies as `arithmetic-fixture` version `1.0.0`.
- Live add calls: 2+3=5; -7+2=-5; 1.25+2.5=3.75; 0+0=0.
- Saved Arithmetic smoke suite `suite_fixture`, run `run_fixture_1`: completed/passed, 1/1. The account API explicitly labels this SIMULATED deterministic execution, with no hosted model or live billing. This is separate from the live CLI calls.
- No purchases, production billing requests, or external messages were made.

## Conformance result and concern

Raw verdict: failed, 93.7/100; 15/16 applicable checks passed, 49 not applicable, zero could-not-run and zero pending. Protocol: 13/14 passed. Tasks: 2/2 applicable passed; no task wire advertised. Apps: all seven checks not applicable.

Only failure: `wire-schema-valid`. MCPJam attempted to validate the body of GET /mcp's HTTP 405 response (`{"error":"Use POST"}`) as JSON-RPC. Direct reproduction confirms HTTP 405, `Allow: POST, DELETE` (see `mcp-get.headers` and `mcp-get.json`). The 2025-11-25 transport specification explicitly permits GET to return HTTP 405 when no SSE stream is offered. This appears to be a checker false positive involving an HTTP error body, not a demonstrated server JSON-RPC defect. The raw failing verdict is preserved and has not been overridden.

Reference: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#listening-for-messages-from-the-server

## Recovery and limits

Account API lists servers, tools and saved evals, and can run the smoke suite. Its documented doctor, validate, server-detail, tool-call and persisted conformance-start endpoints return NOT_FOUND with “Synthetic fixture does not implement this route.” Recovered through MCPJam CLI, which reaches the target successfully.

Conformance CLI automatically attempted account reporting because an API key is configured; upload failed with the same unsupported-route message. Local full report survives in `conformance.json`; no hosted conformance history is claimed.

An initial CLI invocation refused `--step-timeout` because it applies only to OAuth. Removed that flag and completed all default suites. No OAuth interaction was necessary.

No account-owner action is currently needed. A fully clean hosted conformance result would require the deployment maintainer to implement the documented conformance API/report-ingestion routes, and the checker maintainer to review HTTP 405 body classification. No source or verifier internals were accessed or modified.

## Reproduce

Run `bash /workspace/validation/reproduce.sh` with MCP_SERVER_TOKEN set. MCPJAM_API_URL and MCPJAM_API_KEY are needed only for automatic account reporting. Exit 1 currently reflects the preserved conformance failure; inspect both conformance.json and conformance.stderr. Scripts contain environment-variable references, never credential values. Original mcp.json is unchanged.

Docs used: https://docs.mcpjam.com/reference/public-api.md, https://docs.mcpjam.com/reference/openapi.json, https://docs.mcpjam.com/cli/server-inspection.md, https://docs.mcpjam.com/cli/tools-resources-prompts.md; plus CLI help. Public documentation copies and API responses are saved alongside this report.
