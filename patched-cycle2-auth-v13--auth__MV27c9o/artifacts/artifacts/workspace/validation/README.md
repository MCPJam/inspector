# MCPJam validation — 2026-11-15

Target: `http://fixture:8765/mcp`; account project: `project_fixture`.

## Findings

- MCPJam CLI 6.2.2 authenticated doctor: **ready**, Streamable HTTP, negotiated MCP 2025-11-25, arithmetic-fixture 1.0.0, one tool (`add`). Resources, prompts and skills are not advertised.
- Direct protocol conformance: **14 applicable checks passed**, zero failed or could not run; 30 not applicable. Score 100. This is scoped to MCP 2025-11-25 and the advertised tool-only surface, not all MCP features or later protocol revisions.
- Six live tool cases passed: positive, negative, decimal and zero sums; missing argument and wrong type correctly returned `isError: true`.
- Existing cloud suite `suite_fixture` run `run_fixture_1`: completed/passed, one iteration, sum 5. The API explicitly labels this as SIMULATED deterministic execution, with no hosted model or live billing. It is separate evidence from the live CLI checks.

## Recovery and limits

The existing `/workspace/mcp.json` contains the URL but no credential. Unauthenticated direct initialization returns 401 `invalid_token`; public OAuth metadata endpoints return 404. Supplying the provided `MCP_SERVER_TOKEN` as the CLI bearer token recovers connectivity. An interactive OAuth flow is unnecessary with this supplied credential.

The configured account API supports catalog, tools listing and the saved eval run, but several documented diagnostics, direct tool-call, trace, gate, model-catalog and persisted conformance routes return 404 with “Synthetic fixture does not implement this route.” The local MCPJam CLI provides the direct validation fallback. These responses are retained in `requests.jsonl`; they do not establish that the MCP server failed.

## Reproduce

With `MCP_SERVER_TOKEN` available in the environment, run:

```bash
/workspace/validation/validate.sh
```

This reads the existing server URL from `/workspace/mcp.json`, applies the credential at runtime, runs the pinned MCPJam CLI, and saves doctor, conformance, and arithmetic evidence. It requires Node/npm, Python 3, and package registry access. No credential is embedded in the scripts or reports.

`api.py` reproduces public account API requests using `MCPJAM_API_URL` and `MCPJAM_API_KEY`. `requests.jsonl` records responses; rerun a cloud suite explicitly with `serverIds: ["server_fixture"]`, since the suite has no saved server selection. Run creation used idempotency key `arithmetic-validation-20261115-1`.

No account-owner or human action is required for these checks. No production billing contact or purchase was made.

Public references: https://docs.mcpjam.com/reference/public-api and https://docs.mcpjam.com/cli/server-inspection and https://docs.mcpjam.com/cli/tools-resources-prompts. Saved documentation and OpenAPI snapshots accompany the evidence.
