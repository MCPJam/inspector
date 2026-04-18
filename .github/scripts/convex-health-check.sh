#!/usr/bin/env bash
# Health-check script for the PR preview pipeline.
#
# Usage:
#   .github/scripts/convex-health-check.sh <CONVEX_HTTP_URL> <query-path>
#
# Example:
#   .github/scripts/convex-health-check.sh https://foo-123.convex.site chatboxes:listChatboxes
#
# Why: before this script, the pipeline would happily report "preview ready"
# even when the Convex deployment it points at was missing the functions the
# inspector calls. This catches that case loudly instead of shipping a preview
# that 404s in the browser.
#
# Exit codes:
#   0  — Convex responded 2xx to the query (functions are registered).
#   1  — query returned a non-2xx HTTP code, or no response at all.
#   2  — bad usage (missing arguments).
#
# We deliberately call a query that exists on main (staging, preview — any
# healthy deployment) so a 404 proves the deployment itself is broken, not
# just that a specific PR feature is missing.

set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "::error::convex-health-check.sh requires <CONVEX_HTTP_URL> <query-path>" >&2
  exit 2
fi

CONVEX_HTTP="$1"
QUERY_PATH="$2"
ARGS="${3:-{\}}"

if [ -z "$CONVEX_HTTP" ]; then
  echo "::error::CONVEX_HTTP_URL is empty — nothing to check" >&2
  exit 1
fi

# Three attempts with short backoff so a transient Convex cold-start doesn't
# fail the health check.
MAX_ATTEMPTS=3
ATTEMPT=1
while [ "$ATTEMPT" -le "$MAX_ATTEMPTS" ]; do
  RESP_FILE="$(mktemp)"
  HTTP_CODE=$(curl -sS -o "$RESP_FILE" -w "%{http_code}" \
    -H "content-type: application/json" \
    --max-time 20 \
    -d "{\"path\":\"${QUERY_PATH}\",\"args\":${ARGS},\"format\":\"json\"}" \
    "${CONVEX_HTTP%/}/api/query" || echo "000")

  case "$HTTP_CODE" in
    2*)
      echo "::notice::Convex health check OK (${HTTP_CODE}) for ${QUERY_PATH} at ${CONVEX_HTTP}"
      rm -f "$RESP_FILE"
      exit 0
      ;;
    *)
      BODY_PREVIEW=$(head -c 500 "$RESP_FILE" 2>/dev/null || true)
      rm -f "$RESP_FILE"
      if [ "$ATTEMPT" -eq "$MAX_ATTEMPTS" ]; then
        echo "::error::Convex health check failed (HTTP ${HTTP_CODE}) for ${QUERY_PATH} at ${CONVEX_HTTP}" >&2
        echo "::error::Body: ${BODY_PREVIEW}" >&2
        echo "::error::The Convex deployment is reachable but missing this function." >&2
        echo "::error::If this is staging-fallback, run 'convex deploy' against staging from latest main." >&2
        exit 1
      fi
      SLEEP_SECONDS=$((5 * ATTEMPT))
      echo "::warning::Convex health check attempt ${ATTEMPT}/${MAX_ATTEMPTS} failed (HTTP ${HTTP_CODE}); retrying in ${SLEEP_SECONDS}s..." >&2
      sleep "$SLEEP_SECONDS"
      ATTEMPT=$((ATTEMPT + 1))
      ;;
  esac
done
