#!/usr/bin/env bash
# Wait for a Railway deploy to reach a terminal status.
#
# Why this exists:
#   `railway up --ci` streams build logs and exits with the *log stream's*
#   result, not the deploy's. The build-log subscription regularly fails to
#   connect against backboard.railway.com — the CLI retries ~12 times over
#   ~60s and, if not a single log line arrived, gives up with "Failed to
#   stream build logs" and exits 1. Our image takes ~6min to build (Playwright
#   Chromium download), so the build is often still queued when that budget
#   runs out: the workflow goes red while the deploy builds and promotes
#   fine. So every caller deploys with `--detach` and polls status here.
#
# Usage:
#   PREV=$(railway-wait-deploy.sh --latest -s SERVICE_ID -e ENV_ID)
#   railway up --detach ...
#   railway-wait-deploy.sh -s SERVICE_ID -e ENV_ID -p "$PREV"
#
# Env:
#   RAILWAY_API_TOKEN            (required by the CLI) Workspace or account token.
#   RAILWAY_WAIT_POLL_SECONDS    (optional) Poll interval, default 15.
#
# Behavior:
#   - `--latest` prints the newest deployment id, or nothing if the service
#     has never deployed. It retries, and fails loudly if the API never
#     answers — a missing snapshot would make the wait below accept the
#     *previous* deploy's SUCCESS and report a release that never shipped.
#   - Waiting polls the topmost deployment. We can't reliably capture the id
#     `railway up` creates, and railway-retry.sh may have triggered duplicate
#     deploys (if a Railway API blip dropped an otherwise-successful upload
#     response). So: if the top deployment differs from the pre-upload
#     snapshot, treat it as ours; if a newer deploy supersedes it mid-wait,
#     follow the new top.
#   - Exits 0 on SUCCESS, 1 on FAILED/CRASHED. Every other status keeps
#     polling, so callers MUST bound this with `timeout-minutes` on the step.

set -uo pipefail

SERVICE=""
ENVIRONMENT=""
PREVIOUS_ID=""
MODE="wait"

while [ "$#" -gt 0 ]; do
  case "$1" in
    -s) SERVICE="$2"; shift 2 ;;
    -e) ENVIRONMENT="$2"; shift 2 ;;
    -p) PREVIOUS_ID="$2"; shift 2 ;;
    --latest) MODE="latest"; shift ;;
    *)
      echo "::error::railway-wait-deploy.sh: unexpected argument $1" >&2
      exit 2
      ;;
  esac
done

if [ -z "$SERVICE" ] || [ -z "$ENVIRONMENT" ]; then
  echo "::error::railway-wait-deploy.sh: -s SERVICE and -e ENVIRONMENT are required" >&2
  exit 2
fi

POLL_SECONDS="${RAILWAY_WAIT_POLL_SECONDS:-15}"

# Echo "<id>\t<status>" for the newest deployment. Returns non-zero when the
# API call itself failed, which the callers treat as "ask again" rather than
# as a verdict. An empty id with a zero exit means the service genuinely has
# no deployments yet.
#
# Deliberately not wrapped in railway-retry.sh: that helper replays every
# attempt's output on stdout, so a failed attempt would prepend CLI error text
# to the JSON and break the parse. Polling is its own retry.
latest_row() {
  local out
  out=$(railway deployment list \
    --service "$SERVICE" \
    --environment "$ENVIRONMENT" \
    --limit 1 \
    --json 2>/dev/null) || return 1
  printf '%s' "$out" | jq -r '(.[0] // {}) | "\(.id // "")\t\(.status // "")"' 2>/dev/null || return 1
}

if [ "$MODE" = "latest" ]; then
  for _attempt in 1 2 3 4 5; do
    if ROW=$(latest_row); then
      printf '%s\n' "${ROW%%$'\t'*}"
      exit 0
    fi
    sleep 5
  done
  echo "::error::railway-wait-deploy.sh: could not read deployments for service $SERVICE" >&2
  exit 1
fi

echo "Waiting for a new deployment (service=$SERVICE, env=$ENVIRONMENT, previous=${PREVIOUS_ID:-<none>})"

while :; do
  if ROW=$(latest_row); then
    ID="${ROW%%$'\t'*}"
    STATUS="${ROW##*$'\t'}"
    if [ -z "$ID" ] || [ "$ID" = "$PREVIOUS_ID" ]; then
      echo "Waiting for new deployment to appear (latest=${ID:-none}, previous=${PREVIOUS_ID:-none})"
    else
      case "$STATUS" in
        SUCCESS)
          echo "Deploy $ID succeeded"
          exit 0
          ;;
        FAILED|CRASHED)
          echo "::error::Deploy $ID ended in status $STATUS"
          exit 1
          ;;
        "")
          echo "Status not readable yet for $ID"
          ;;
        *)
          echo "Deploy $ID status: $STATUS"
          ;;
      esac
    fi
  else
    echo "::warning::Could not read deployment status; retrying"
  fi
  sleep "$POLL_SECONDS"
done
