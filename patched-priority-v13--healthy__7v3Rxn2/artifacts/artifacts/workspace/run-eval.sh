#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
: "${MCPJAM_API_URL:?Set MCPJAM_API_URL to the trial account API URL}"
: "${MCPJAM_API_KEY:?Set MCPJAM_API_KEY to the trial account API key}"
mkdir -p reports
./node_modules/.bin/mcpjam cloud eval validate --file arithmetic.eval.json --project project_fixture --format json > reports/validation.json
./node_modules/.bin/mcpjam cloud eval run --file arithmetic.eval.json --project project_fixture --wait --wait-timeout 45000 --out reports/eval.json --format json > reports/launch.json
