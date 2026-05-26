#!/usr/bin/env bash
# Set Railway service variables via the GraphQL API.
#
# Why this exists:
#   `railway variable set` (CLI 4.57.x) does an internal user-identity check
#   that fails with "Unauthorized" when authenticated via a workspace token —
#   even though the underlying `variableUpsert` mutation works with the exact
#   same token. We call the mutation directly to sidestep that CLI bug.
#
# Usage:
#   railway-set-vars.sh -e ENV_ID -s SERVICE_ID KEY1=val1 KEY2=val2 ...
#
# Env:
#   RAILWAY_API_TOKEN   (required) Workspace or account token.
#   RAILWAY_PROJECT_ID  (required) Project ID the env+service live under.
#
# Behavior:
#   - One mutation per KEY=value (variableUpsert is single-variable).
#   - Fails the whole script on the first mutation error so callers get a
#     loud signal — Railway returns HTTP 200 even on auth errors, so we
#     inspect the JSON `errors` field.

set -euo pipefail

: "${RAILWAY_API_TOKEN:?RAILWAY_API_TOKEN must be set}"
: "${RAILWAY_PROJECT_ID:?RAILWAY_PROJECT_ID must be set}"

ENV_ID=""
SERVICE_ID=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -e) ENV_ID="$2"; shift 2 ;;
    -s) SERVICE_ID="$2"; shift 2 ;;
    --) shift; break ;;
    -*)
      echo "::error::railway-set-vars.sh: unknown flag $1" >&2
      exit 2
      ;;
    *) break ;;
  esac
done

if [ -z "$ENV_ID" ] || [ -z "$SERVICE_ID" ]; then
  echo "::error::railway-set-vars.sh: -e ENV_ID and -s SERVICE_ID are required" >&2
  exit 2
fi

if [ "$#" -eq 0 ]; then
  echo "::error::railway-set-vars.sh: no KEY=value pairs given" >&2
  exit 2
fi

ENDPOINT="https://backboard.railway.app/graphql/v2"

# Accept either a UUID or an environment NAME for -e. The Railway CLI does
# this transparently; the GraphQL API does not. Resolve names → UUIDs by
# querying the project's environments.
UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
if ! [[ "$ENV_ID" =~ $UUID_RE ]]; then
  RESOLVE_PAYLOAD=$(jq -nc \
    --arg q 'query R($id: String!){ project(id: $id){ environments { edges { node { id name } } } } }' \
    --arg id "$RAILWAY_PROJECT_ID" \
    '{query: $q, variables: {id: $id}}')
  RESOLVE_RESPONSE=$(curl -fsS -X POST "$ENDPOINT" \
    -H "Authorization: Bearer $RAILWAY_API_TOKEN" \
    -H "Content-Type: application/json" \
    --data "$RESOLVE_PAYLOAD")
  RESOLVED=$(echo "$RESOLVE_RESPONSE" \
    | jq -r --arg name "$ENV_ID" '.data.project.environments.edges[]?.node | select(.name == $name) | .id')
  if [ -z "$RESOLVED" ]; then
    echo "::error::railway-set-vars.sh: no environment named '$ENV_ID' under project $RAILWAY_PROJECT_ID" >&2
    echo "$RESOLVE_RESPONSE" | jq '.' >&2 || echo "$RESOLVE_RESPONSE" >&2
    exit 1
  fi
  echo "resolved env '$ENV_ID' → $RESOLVED"
  ENV_ID="$RESOLVED"
fi

MUTATION='mutation U($input: VariableUpsertInput!){ variableUpsert(input: $input) }'

for pair in "$@"; do
  if [[ "$pair" != *=* ]]; then
    echo "::error::railway-set-vars.sh: expected KEY=value, got '$pair'" >&2
    exit 2
  fi
  KEY="${pair%%=*}"
  VALUE="${pair#*=}"

  PAYLOAD=$(jq -nc \
    --arg q "$MUTATION" \
    --arg p "$RAILWAY_PROJECT_ID" \
    --arg e "$ENV_ID" \
    --arg s "$SERVICE_ID" \
    --arg n "$KEY" \
    --arg v "$VALUE" \
    '{query: $q, variables: {input: {projectId: $p, environmentId: $e, serviceId: $s, name: $n, value: $v}}}')

  RESPONSE=$(curl -fsS -X POST "$ENDPOINT" \
    -H "Authorization: Bearer $RAILWAY_API_TOKEN" \
    -H "Content-Type: application/json" \
    --data "$PAYLOAD")

  if echo "$RESPONSE" | jq -e '.errors' >/dev/null 2>&1; then
    echo "::error::variableUpsert failed for $KEY:" >&2
    echo "$RESPONSE" | jq '.errors' >&2
    exit 1
  fi

  echo "set $KEY"
done
