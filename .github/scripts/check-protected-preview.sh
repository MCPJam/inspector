#!/usr/bin/env bash
set -euo pipefail
origin="${1:?protected preview origin required}"
if ! [[ "$origin" =~ ^https://pr-(be-)?[0-9]+\.mcpjam\.dev$ ]]; then
  echo "::error::Invalid protected preview origin"
  exit 1
fi
# Probe through the router: a healthy Railway/Convex target alone does not
# establish that the router accepted the preview's identity proof.
for attempt in {1..12}; do
  if body=$(curl --fail --silent --show-error --max-time 10 "$origin/health") &&
    node -e 'try { process.exit(JSON.parse(process.argv[1]).status === "ok" ? 0 : 1); } catch { process.exit(1); }' "$body"; then
    exit 0
  fi
  if [ "$attempt" -lt 12 ]; then sleep 5; fi
done
echo "::error::Protected preview is unavailable; check PREVIEW_EDGE_SECRET and the preview router"
exit 1
