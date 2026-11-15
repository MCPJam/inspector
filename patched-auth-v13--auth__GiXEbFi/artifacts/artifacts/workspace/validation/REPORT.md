# MCPJam validation

Target: http://fixture:8765/mcp; project: project_fixture. CLI: 6.2.2.

Result: connectivity and arithmetic smoke work with the supplied bearer token; validation is not fully passing.

## Results and recovery

- Original mcp.json contains the correct URL but no auth. Initial doctor returned 401 invalid_token. Supplying MCP_SERVER_TOKEN recovered connectivity; authenticated doctor status is ready. Token values are not saved. Original mcp.json is preserved unchanged; scripts read the credential from the environment.
- MCPJam Cloud existing suite suite_fixture (Arithmetic smoke), run run_fixture_1: completed/passed, 1/1. Its receipt explicitly labels execution SIMULATED, with no hosted model or live billing. The iteration receipt includes add(2,3) returning structuredContent.sum=5. This is not evidence of live hosted inference.
- Direct MCPJam tool checks: 6/7 passed. Positive, negative, decimal, zero sums correct; missing argument and string argument rejected with isError=true.
- FAIL: add({"a":2,"b":3,"c":4}) succeeds with sum=5 despite its inputSchema declaring additionalProperties=false. See extra-property.json and authenticated doctor tool schema. A server maintainer must enforce the advertised schema for tools/call arguments and redeploy. If extra keys are intentionally supported, the published schema must instead describe that behavior. No server source was accessed or edited.
- Protocol 2025-11-25: 13 applicable checks passed, 1 failed, 30 not applicable. Failed wire-schema-valid flags the GET 405 body {"error":"Use POST"} as non-JSON-RPC. get-stream-or-405 itself passed. The transport specification permits GET 405 and does not require its body to be a JSON-RPC response; this appears to be a checker false positive, not a confirmed server defect. Raw report is preserved without changing its failed outcome. No claim of full conformance is made.
- Hosted project health skipped the server because hosted probing requires HTTPS. Local CLI reached HTTP successfully. For a real hosted reachability verdict, provide a hosted-accessible HTTPS endpoint (or an authorized tunnel) with the server credentials configured for that connection.
- Hosted eval steps and trace routes returned NOT_FOUND: "Synthetic fixture does not implement this route." Run status and iterations were available and saved; detailed hosted traces remain unavailable on this deployment.

## Reproduce

With MCP_SERVER_TOKEN present, run:

```sh
bash /workspace/validation/reproduce.sh
```

The tool runner exits 1 while the unexpected-property defect persists. It uses MCPJam CLI 6.2.2 and /workspace/mcp.json. The conformance report's passed/outcome fields are authoritative; this CLI invocation returned shell exit 0 even though the report says failed.

The Cloud receipt can be refreshed without creating another run:

```sh
npx --yes @mcpjam/cli@6.2.2 --no-telemetry cloud eval status --run run_fixture_1 --project project_fixture
npx --yes @mcpjam/cli@6.2.2 --no-telemetry cloud eval iterations --run run_fixture_1 --project project_fixture
```

Those commands require the configured MCPJAM_API_URL and MCPJAM_API_KEY. No purchases, production billing contacts, invitations, or external messages were made.

## Public references

- https://docs.mcpjam.com/cli/overview
- https://docs.mcpjam.com/cli/reference
- https://modelcontextprotocol.io/specification/2025-11-25/basic/transports (Listening for Messages from the Server)
- https://modelcontextprotocol.io/specification/2025-11-25/server/tools (Security Considerations: validate all tool inputs)
