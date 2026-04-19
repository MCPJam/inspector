#!/usr/bin/env bash
# Retry wrapper for flaky Railway CLI calls in the PR preview pipeline.
#
# Usage:
#   .github/scripts/railway-retry.sh railway variable set -e $ENV -s $SVC KEY=VAL
#   .github/scripts/railway-retry.sh railway link --project ... --environment ...
#   .github/scripts/railway-retry.sh railway up --ci --project ... --environment ...
#
# Behavior:
#   - Runs the given command up to 5 times.
#   - Waits 10, 20, 40, 80s between attempts (exponential backoff).
#   - Exits 0 on first success.
#   - On final failure, prints the last command's stderr and exits with its code.
#
# Matches the pattern already used for `npx convex deploy` in the backend
# preview-deploy workflow, extracted here so every Railway CLI call on the
# inspector side can reuse it. See `.github/workflows/pr-preview.yml`.

set -uo pipefail

MAX_ATTEMPTS="${RAILWAY_RETRY_ATTEMPTS:-5}"
ATTEMPT=1

if [ "$#" -lt 1 ]; then
  echo "::error::railway-retry.sh requires a command to run" >&2
  exit 2
fi

OUTPUT_FILE="$(mktemp)"
trap 'rm -f "$OUTPUT_FILE"' EXIT

while [ "$ATTEMPT" -le "$MAX_ATTEMPTS" ]; do
  # Re-run the full command; preserve exit code separately from our loop vars.
  "$@" 2>&1 | tee "$OUTPUT_FILE"
  STATUS="${PIPESTATUS[0]}"

  if [ "$STATUS" -eq 0 ]; then
    exit 0
  fi

  if [ "$ATTEMPT" -eq "$MAX_ATTEMPTS" ]; then
    echo "::error::Railway CLI failed after $MAX_ATTEMPTS attempts: $*" >&2
    exit "$STATUS"
  fi

  SLEEP_SECONDS=$((10 * (2 ** (ATTEMPT - 1))))
  echo "::warning::Railway CLI attempt $ATTEMPT/$MAX_ATTEMPTS failed (exit $STATUS); retrying in ${SLEEP_SECONDS}s..." >&2
  sleep "$SLEEP_SECONDS"
  ATTEMPT=$((ATTEMPT + 1))
done
