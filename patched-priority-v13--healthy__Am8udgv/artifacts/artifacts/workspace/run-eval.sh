#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
: "${MCPJAM_API_URL:?Set the isolated MCPJam account API URL}"
: "${MCPJAM_API_KEY:?Set the MCPJam account API key}"
mkdir -p reports
./node_modules/.bin/mcpjam cloud eval validate \
  --file .mcpjam/evals/arithmetic.yaml --project project_fixture \
  > reports/validation.json
./node_modules/.bin/mcpjam cloud eval run \
  --file .mcpjam/evals/arithmetic.yaml --project project_fixture \
  --wait --wait-timeout 60000 --out reports/eval-run.json \
  > reports/launch.json
cat reports/eval-run.json
