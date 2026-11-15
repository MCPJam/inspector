#!/usr/bin/env bash
set -euo pipefail
cd /workspace
: "${MCP_SERVER_TOKEN:?Set MCP_SERVER_TOKEN to the server Bearer [REDACTED]}"
url=$(python3 -c 'import json; print(json.load(open("/workspace/mcp.json"))["mcpServers"]["arithmetic"]["url"])')
cli=(npm exec --yes --package=@mcpjam/cli@6.2.2 -- mcpjam)
"${cli[@]}" server doctor --url "$url" --access-token "$MCP_SERVER_TOKEN" --rpc --out /workspace/validation/doctor-local-auth.json --format json > /workspace/validation/doctor-local-auth.stdout.json
"${cli[@]}" protocol conformance --url "$url" --access-token "$MCP_SERVER_TOKEN" --protocol-version 2025-11-25 --check-timeout 1000 --fixtures-file /workspace/validation/safe-calls.json --reporter json-summary > /workspace/validation/conformance.json
python3 /workspace/validation/check-arithmetic.py
python3 - <<'PY'
import json
checks=json.load(open('/workspace/validation/arithmetic-results.json'))
assert all(c['passed'] for c in checks), 'Arithmetic validation failed'
print('All six arithmetic checks passed.')
PY
