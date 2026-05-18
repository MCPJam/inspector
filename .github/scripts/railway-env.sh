#!/usr/bin/env bash
# Create/delete Railway environments via the GraphQL API.
#
# Why this exists: `railway environment new` and `railway environment delete`
# (CLI 4.57.x) do an internal user-identity check that fails with
# "Unauthorized" when authenticated with a workspace token — even though the
# corresponding `environmentCreate` / `environmentDelete` mutations work
# with the same token (verified locally). Call the mutations directly.
#
# Usage:
#   railway-env.sh new <NAME> --duplicate <SOURCE_NAME_OR_ID>
#   railway-env.sh delete <NAME_OR_ID> [--yes]
#
# Env:
#   RAILWAY_API_TOKEN   (required) Workspace or account token.
#   RAILWAY_PROJECT_ID  (required) Project the env lives under.
#
# Behavior:
#   - `new`: succeeds if the env is created. If a same-named env already
#     exists, treat as success (mirrors the workflow's `|| true` semantics
#     for replays).
#   - `delete`: succeeds if the env is deleted OR didn't exist (idempotent).

set -euo pipefail

: "${RAILWAY_API_TOKEN:?RAILWAY_API_TOKEN must be set}"
: "${RAILWAY_PROJECT_ID:?RAILWAY_PROJECT_ID must be set}"

ENDPOINT="https://backboard.railway.app/graphql/v2"
UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

gql() {
  curl -fsS -X POST "$ENDPOINT" \
    -H "Authorization: Bearer $RAILWAY_API_TOKEN" \
    -H "Content-Type: application/json" \
    --data "$1"
}

resolve_env_id() {
  local input="$1"
  if [[ "$input" =~ $UUID_RE ]]; then
    echo "$input"
    return 0
  fi
  local payload
  payload=$(jq -nc \
    --arg q 'query R($id: String!){ project(id: $id){ environments { edges { node { id name } } } } }' \
    --arg id "$RAILWAY_PROJECT_ID" \
    '{query: $q, variables: {id: $id}}')
  local response
  response=$(gql "$payload")
  echo "$response" \
    | jq -r --arg name "$input" '.data.project.environments.edges[]?.node | select(.name == $name) | .id'
}

cmd="${1:-}"
shift || true

case "$cmd" in
  new)
    NAME="${1:-}"
    shift || true
    SOURCE=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --duplicate) SOURCE="$2"; shift 2 ;;
        *) echo "::error::railway-env.sh new: unknown arg $1" >&2; exit 2 ;;
      esac
    done
    if [ -z "$NAME" ] || [ -z "$SOURCE" ]; then
      echo "::error::railway-env.sh new <name> --duplicate <source>" >&2
      exit 2
    fi
    SOURCE_ID=$(resolve_env_id "$SOURCE")
    if [ -z "$SOURCE_ID" ]; then
      echo "::error::railway-env.sh new: source env '$SOURCE' not found" >&2
      exit 1
    fi
    # Idempotent: if NAME already exists, return success.
    EXISTING=$(resolve_env_id "$NAME")
    if [ -n "$EXISTING" ]; then
      echo "environment '$NAME' already exists ($EXISTING)"
      exit 0
    fi
    PAYLOAD=$(jq -nc \
      --arg q 'mutation C($input: EnvironmentCreateInput!){ environmentCreate(input: $input) { id name } }' \
      --arg p "$RAILWAY_PROJECT_ID" \
      --arg n "$NAME" \
      --arg s "$SOURCE_ID" \
      '{query: $q, variables: {input: {projectId: $p, name: $n, sourceEnvironmentId: $s}}}')
    RESPONSE=$(gql "$PAYLOAD")
    if echo "$RESPONSE" | jq -e '.errors' >/dev/null 2>&1; then
      echo "::error::environmentCreate failed:" >&2
      echo "$RESPONSE" | jq '.errors' >&2
      exit 1
    fi
    NEW_ID=$(echo "$RESPONSE" | jq -r '.data.environmentCreate.id')
    echo "created environment '$NAME' ($NEW_ID)"
    ;;
  delete)
    NAME="${1:-}"
    shift || true
    # Accept and ignore --yes for parity with `railway environment delete`.
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --yes) shift ;;
        *) echo "::error::railway-env.sh delete: unknown arg $1" >&2; exit 2 ;;
      esac
    done
    if [ -z "$NAME" ]; then
      echo "::error::railway-env.sh delete <name>" >&2
      exit 2
    fi
    ENV_ID=$(resolve_env_id "$NAME")
    if [ -z "$ENV_ID" ]; then
      echo "environment '$NAME' not found — nothing to delete"
      exit 0
    fi
    PAYLOAD=$(jq -nc \
      --arg q 'mutation D($id: String!){ environmentDelete(id: $id) }' \
      --arg id "$ENV_ID" \
      '{query: $q, variables: {id: $id}}')
    RESPONSE=$(gql "$PAYLOAD")
    if echo "$RESPONSE" | jq -e '.errors' >/dev/null 2>&1; then
      echo "::error::environmentDelete failed:" >&2
      echo "$RESPONSE" | jq '.errors' >&2
      exit 1
    fi
    echo "deleted environment '$NAME' ($ENV_ID)"
    ;;
  *)
    echo "::error::railway-env.sh: unknown subcommand '$cmd' (expected new|delete)" >&2
    exit 2
    ;;
esac
