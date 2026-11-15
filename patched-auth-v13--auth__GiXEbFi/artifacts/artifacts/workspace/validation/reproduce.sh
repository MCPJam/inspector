#!/usr/bin/env bash
set -u
cd /workspace
: "${MCP_SERVER_TOKEN:?Set MCP_SERVER_TOKEN}"
cli=(npx --yes @mcpjam/cli@6.2.2 --no-telemetry)
"${cli[@]}" server doctor --url http://fixture:8765/mcp --access-token "$MCP_SERVER_TOKEN" --out validation/doctor-authenticated.json > validation/doctor-authenticated.stdout.json 2> validation/doctor-authenticated.stderr
"${cli[@]}" protocol conformance --url http://fixture:8765/mcp --access-token "$MCP_SERVER_TOKEN" --protocol-version 2025-11-25 --check-timeout 2000 --fixtures-file validation/safe-calls.json --reporter json-summary > validation/protocol.json 2> validation/protocol.stderr
python3 validation/validate.py
