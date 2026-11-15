#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
: "${MCPJAM_API_URL:?Set the isolated MCPJam API URL}"
: "${MCPJAM_API_KEY:?Set the MCPJam API key}"
mkdir -p artifacts
./node_modules/.bin/mcpjam cloud eval validate --file .mcpjam/evals/arithmetic.json --project project_fixture --no-telemetry --format json > artifacts/validation.json
./node_modules/.bin/mcpjam cloud eval run --file .mcpjam/evals/arithmetic.json --project project_fixture --wait --wait-timeout 30000 --out artifacts/eval-report.json --no-telemetry --format json > artifacts/run.json 2> artifacts/run.stderr
cat artifacts/eval-report.json
