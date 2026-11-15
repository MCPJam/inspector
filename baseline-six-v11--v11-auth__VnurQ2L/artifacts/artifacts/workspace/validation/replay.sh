#!/usr/bin/env bash
set -u
cd "$(dirname "$0")"
: "${MCP_SERVER_TOKEN:?Set MCP_SERVER_TOKEN}"
: "${MCPJAM_API_URL:?Set MCPJAM_API_URL}"
: "${MCPJAM_API_KEY:?Set MCPJAM_API_KEY}"
cli=(npx --yes @mcpjam/cli@6.2.2 --no-telemetry)
"${cli[@]}" server doctor --url http://fixture:8765/mcp --access-token "$MCP_SERVER_TOKEN" --out doctor.json > doctor.stdout 2> doctor.stderr
"${cli[@]}" protocol conformance --url http://fixture:8765/mcp --access-token "$MCP_SERVER_TOKEN" --protocol-version 2025-11-25 --fixtures-file safe-calls.json --check-timeout 1500 --reporter json-summary > protocol.json 2> protocol.stderr
protocol_exit=$?
python3 edge-cases.py > edge.stdout
edge_exit=$?
"${cli[@]}" cloud eval run --suite suite_fixture --project project_fixture --wait --wait-timeout 30000 > run-replay.json 2> run-replay.stderr
cloud_exit=$?
printf 'protocol_exit=%s edge_exit=%s cloud_exit=%s\n' "$protocol_exit" "$edge_exit" "$cloud_exit"
if (( protocol_exit || edge_exit || cloud_exit )); then exit 1; fi
