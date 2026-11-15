#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
: "${MCPJAM_API_URL:?Set the isolated MCPJam account API URL}"
: "${MCPJAM_API_KEY:?Set the MCPJam account API key}"
if [[ ! -x node_modules/.bin/mcpjam ]]; then
  npm ci
fi
./node_modules/.bin/mcpjam cloud eval validate --file suite.json --no-telemetry > validation.json
./node_modules/.bin/mcpjam cloud eval run \
  --file suite.json --project project_fixture \
  --wait --wait-timeout 60000 --out eval-report.json \
  --no-telemetry > run.json
