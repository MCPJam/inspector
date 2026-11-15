# MCPJam validation — 2026-11-15

Target: http://fixture:8765/mcp. Project: project_fixture. CLI: @mcpjam/cli 6.2.2.

## Results

- Authenticated doctor: ready; arithmetic-fixture 1.0.0, protocol 2025-11-25, one read-only add tool.
- Existing Arithmetic smoke suite: run_fixture_1 completed/passed, 1/1. Product explicitly labels execution SIMULATED, with no hosted model or live billing. This does not establish hosted model performance.
- Direct add(2,3): structuredContent.sum = 5; envelope validation passed.
- Zero, negative and fractional operands: passed. Missing operand and string operand: rejected with isError=true.
- Extra property: add({a:2,b:3,c:4}) returned sum=5, isError=false, despite published inputSchema.additionalProperties=false. The server should enforce its advertised input schema or revise that schema to describe the accepted contract. This is a contract mismatch; no remote implementation was changed.
- Without the supplied token, initialization returned HTTP 401 invalid_token. OAuth resource metadata returned 404. Static Bearer [REDACTED] with MCP_SERVER_TOKEN succeeds; no interactive OAuth is needed for this validation. Original /workspace/mcp.json contains no authentication; replay.sh supplies the token from the environment.
- Full protocol conformance: 13 passed, 1 failed, 30 not applicable (14 applicable; score 92.8). The failure is wire-schema-valid treating GET /mcp's HTTP 405 body {"error":"Use POST"} as a JSON-RPC message. GET-or-405 itself passed. The MCP transport specification explicitly permits HTTP 405 for this GET. The finding may be a checker false positive; the spec does not require that response body to be JSON-RPC. Needs checker review, not a claim of full conformance.
- Focused rerun of get-stream-or-405 and wire-schema-valid passed both. Full and focused results disagree; retain both reports. Do not use the focused pass to erase the full-run failure.
- Hosted suite export refused UNSUPPORTED_SUITE_EXPORT because environment servers and model are absent and minimumIterations cannot be represented losslessly. Raw suite settings and cases are preserved instead; suite settings were not changed to force export.

## Reproduce

Set MCP_SERVER_TOKEN, MCPJAM_API_URL and MCPJAM_API_KEY in the environment, then run:

```sh
bash /workspace/validation/replay.sh
```

Requires Node/npm and Python 3. Pinned public npm CLI is used. The script writes new artifacts and launches one simulated hosted suite run. It exits nonzero while full conformance or edge expectations fail. It stores no credential values. For local arithmetic checks only, run `python3 /workspace/validation/edge-cases.py`.

Key artifacts: doctor.json, add.json, edge-results.json, protocol.json, protocol-focused.json, get-response.json, probe-unauthenticated.json, run-first.json, iterations.json, suite-settings.json, cases.json, export.json.

## Remaining action

No account-owner login, credit purchase, or production billing action is needed. Correcting server input enforcement requires access to the server implementation/deployment, outside the allowed public-interface validation scope. A server maintainer should reject extra properties or intentionally update the published schema, then rerun the checks. A MCPJam checker maintainer should review the full/focused wire-schema discrepancy using the saved reports and GET response. No external messages or support requests were sent.

Public references:
- https://docs.mcpjam.com/cli/overview
- https://docs.mcpjam.com/cli/reference
- https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#listening-for-messages-from-the-server
