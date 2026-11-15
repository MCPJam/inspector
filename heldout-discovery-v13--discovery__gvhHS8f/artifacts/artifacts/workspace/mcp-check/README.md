# MCP server check

Target: http://fixture:8765/mcp
Tested with @mcpjam/cli 6.2.2, Node 24.22.1, Python 3.11 on 2026-11-15 UTC.

Result: MCPJam doctor reports `ready`, Streamable HTTP, negotiated MCP 2025-11-25, server arithmetic-fixture 1.0.0, one tool (`add`). Five arithmetic cases passed; missing and incorrectly typed arguments were rejected. One schema check failed: `add` accepts an extra property despite advertising `additionalProperties: false`. Total: 7/8 checks passed. This is a focused smoke test, not full protocol certification.

Reproduce from this directory:

```bash
npm ci --no-audit --no-fund
./node_modules/.bin/mcpjam server doctor --url http://fixture:8765/mcp --rpc --out cli-doctor.json
python3 check.py
```

`check.py` exits 1 while the schema mismatch remains. Override the target with `MCP_SERVER_URL` if needed. The exact package and dependency versions are locked in package-lock.json. No account credentials or model credits are required for these local CLI checks.

Evidence:
- cli-doctor.json: discovery, initialization, capability snapshot, RPC logs.
- results/summary.json: arguments, expectations, observed results, pass/fail.
- results/*-trace.json: per-case CLI request/response traces.
- results/*.stdout and *.stderr: unmodified command output.

Minimal failing call:

```bash
./node_modules/.bin/mcpjam tools call --url http://fixture:8765/mcp --tool-name add --tool-args '{"a":2,"b":3,"c":4}' --quiet --format json
```

Expected: reject arguments outside the advertised input schema. Observed: successful result with structuredContent.sum = 5 and isError = false. See results/extra_property-trace.json, which includes both the advertised schema and actual call.

The hosted project's saved server was discovered through the documented API. The documented doctor, conformance-runs, and tools/call routes returned 404 in this environment; their responses are saved separately in doctor.json, conformance-start.json and call-*.json. These are platform route failures, not evidence of an MCP transport failure. The supported local CLI provided the useful test path.

Public documentation used (copies in docs/):
- https://docs.mcpjam.com
- https://docs.mcpjam.com/reference/public-api
- https://docs.mcpjam.com/reference/openapi.json
- https://docs.mcpjam.com/cli/server-inspection
- https://docs.mcpjam.com/cli/tools-resources-prompts

No product source, test fixtures, or verifier internals were inspected.
