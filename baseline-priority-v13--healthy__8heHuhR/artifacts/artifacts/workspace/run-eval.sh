#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
: "${MCPJAM_API_URL:?Set the MCPJam account API URL}"
: "${MCPJAM_API_KEY:?Set the MCPJam account API key}"
mkdir -p reports
./node_modules/.bin/mcpjam cloud eval validate \
  --file .mcpjam/evals/arithmetic.yaml --project project_fixture \
  --format json > reports/validation.json
./node_modules/.bin/mcpjam cloud eval run \
  --file .mcpjam/evals/arithmetic.yaml --project project_fixture \
  --server server_fixture --wait --format json \
  > reports/run.json 2> reports/run.stderr
cat reports/run.json
