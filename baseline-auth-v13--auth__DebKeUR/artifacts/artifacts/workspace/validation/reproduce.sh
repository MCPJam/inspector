#!/usr/bin/env bash
set -u
cd "$(dirname "$0")"
: "${MCP_SERVER_TOKEN:?Set MCP_SERVER_TOKEN to the supplied server credential}"
npx --yes @mcpjam/cli@6.2.2 server doctor --url http://fixture:8765/mcp --access-token "$MCP_SERVER_TOKEN" --rpc --out cli-doctor-authenticated.json > cli-doctor-authenticated.log 2>&1
python3 check-arithmetic.py
arithmetic_status=$?
npx --yes @mcpjam/cli@6.2.2 conformance run --suite protocol --url http://fixture:8765/mcp --access-token "$MCP_SERVER_TOKEN" --fixtures-file safe-inputs.json --check-timeout 2000 --reporter json-summary > protocol-conformance.json 2> protocol-conformance.stderr
conformance_status=$?
printf 'Arithmetic checks exit: %s; conformance exit: %s\n' "$arithmetic_status" "$conformance_status"
if (( arithmetic_status != 0 || conformance_status != 0 )); then exit 1; fi
