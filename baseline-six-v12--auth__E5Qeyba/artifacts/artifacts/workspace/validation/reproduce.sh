#!/usr/bin/env bash
set -u
cd /workspace
: "${MCP_SERVER_TOKEN:?Set MCP_SERVER_TOKEN}"
server_url=$(node -e 'console.log(require("/workspace/mcp.json").mcpServers.arithmetic.url)')
npx -y @mcpjam/cli@6.2.2 --no-telemetry server doctor --url "$server_url" --access-token "$MCP_SERVER_TOKEN" --rpc --out /workspace/validation/doctor.json > /workspace/validation/doctor.stdout 2> /workspace/validation/doctor.stderr
npx -y @mcpjam/cli@6.2.2 --no-telemetry tools call --url "$server_url" --access-token "$MCP_SERVER_TOKEN" --tool-name add --tool-args '{"a":2,"b":3}' --format json --debug-out /workspace/validation/add-debug.json > /workspace/validation/add.json 2> /workspace/validation/add.stderr
/workspace/validation/check-arithmetic.sh
npx -y @mcpjam/cli@6.2.2 --no-telemetry conformance run --url "$server_url" --access-token "$MCP_SERVER_TOKEN" --protocol-version 2025-11-25 --fixtures-file /workspace/validation/safe-calls.json --check-timeout 2000 --reporter json-summary > /workspace/validation/conformance.json 2> /workspace/validation/conformance.stderr
conformance_exit=$?
printf 'Conformance exit: %s (inspect conformance.json and conformance.stderr)\n' "$conformance_exit"
exit "$conformance_exit"
