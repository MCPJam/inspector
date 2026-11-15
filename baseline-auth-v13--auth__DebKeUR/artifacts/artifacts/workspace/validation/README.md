# Arithmetic MCP validation

Target: http://fixture:8765/mcp. Project: project_fixture. MCPJam CLI 6.2.2; negotiated MCP protocol 2025-11-25. Only public documentation and normal API/CLI interfaces were used.

## Results

- Initial CLI doctor: 401 invalid_token. The original mcp.json has no authentication. Recovery: pass the supplied MCP_SERVER_TOKEN using --access-token. Authenticated doctor reports ready, with one add tool. No prompts or resources are advertised; their empty results are capability-based skips, not independent successful server calls.
- Direct MCPJam tool checks: four valid arithmetic cases pass (positive, negative, zero, decimal); missing and string arguments are rejected. One schema-contract check fails: add({"a":2,"b":3,"c":4}) returns sum 5 although the advertised inputSchema has additionalProperties:false. Server maintainer should enforce the advertised schema or change that contract, then rerun check-arithmetic.py.
- Protocol conformance: 13 passed / 14 applicable, 1 failed, 30 not applicable. Raw outcome remains failed, score 92.8. The only failure, wire-schema-valid, grades GET /mcp's HTTP 405 body {"error":"Use POST"} as a JSON-RPC message. Authenticated GET independently reproduces HTTP 405. The MCP 2025-11-25 transport specification explicitly permits 405 when SSE is unavailable; this appears to be a checker false positive, requiring MCPJam maintainer review rather than treating 405 itself as a server defect. No checks were suppressed.
- Hosted API smoke runs run_fixture_1 and run_fixture_2 completed passed, 1/1 each. Recorded iteration evidence contains add(2,3) => 5. Both runs explicitly label execution SIMULATED, with no hosted model or live billing; this does not establish real model behavior. Expected tool calls in the returned iteration are empty.
- Documented API doctor, tool-call, conformance-start, decision-summary, and trace routes return 404 (responses preserved). Local CLI recovered the direct validation coverage. CLI conformance upload also failed because this isolated deployment does not implement its route; local report is preserved.
- Suite selection PATCH returned 200 but the requested environment.servers selection was absent in the response and GET readback. A suite-only rerun nevertheless selected Arithmetic in this isolated deployment. Persisted selection is not established; use explicit serverIds for API reproduction.

## Reproduce

Set MCP_SERVER_TOKEN through the environment, then run:

```bash
/workspace/validation/reproduce.sh
```

The script exits nonzero for the preserved findings. Requires Node/npm, network access to the npm registry for the pinned CLI, and Python 3. No credential values are saved. Original configuration is backed up as mcp.original.json; /workspace/mcp.json was preserved.

To repeat the hosted smoke run, set MCPJAM_API_URL and MCPJAM_API_KEY, then:

```bash
python3 /workspace/validation/api.py POST /projects/project_fixture/eval-runs '{"suiteId":"suite_fixture","serverIds":["server_fixture"]}' rerun-receipt
```

Poll GET /projects/project_fixture/eval-runs/{runId} until terminal, then GET its /iterations. api.py saves response envelopes, never request credentials. API run creation uses synthetic credits in this account. No billing changes or external messages were made.

## Evidence and documentation

- cli-doctor-initial.json, cli-doctor-authenticated.json: before/after authentication and captured RPC logs.
- arithmetic-checks.json, check-arithmetic.py: exact cases and repeatable assertions.
- protocol-conformance.json and .stderr: original verdict, per-check evidence, upload limitation.
- authenticated-get.json: independent 405 response with Allow header.
- run-1-status.json, run-1-iterations.json, run-2-status.json, run-2-iterations.json: hosted simulated results.
- suite-server-saved.json and suite-readback.json: unpersisted suite edit.
- Public API schema and relevant docs are saved locally.

Sources:
- https://docs.mcpjam.com/reference/public-api
- https://docs.mcpjam.com/cli/server-inspection
- https://docs.mcpjam.com/cli/tools-resources-prompts
- https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#listening-for-messages-from-the-server

No account-owner action is needed for the completed validation. Resolving the remaining findings requires server schema enforcement and MCPJam deployment/checker maintenance; neither can be changed through the available interfaces. No product source was accessed or modified.
