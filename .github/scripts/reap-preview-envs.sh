#!/usr/bin/env bash
# Delete Railway PR preview environments whose PR is no longer open.
#
# Why this exists: the `destroy-preview` and `destroy-backend-pr-preview`
# jobs in pr-preview.yml only run when GitHub delivers the PR's `closed`
# event, and that is not reliable. GitHub never starts a `pull_request`
# workflow for a PR that has a merge conflict — close included — and bulk
# closes lose runs too. A close run can also die (CLI install), be cancelled
# by a late backend callback sharing its concurrency group, or be followed by
# an upsert that recreates the environment. Every one of those leaves a full
# inspector running with nothing to stop it. This reaper keys on PR state
# instead of on events, so it catches all of them.
#
# Usage:
#   .github/scripts/reap-preview-envs.sh
#
# Env:
#   RAILWAY_API_TOKEN       (required) Workspace or account token.
#   RAILWAY_PROJECT_ID      (required) Project the preview envs live under.
#   GITHUB_TOKEN            (required) Reads PRs in INSPECTOR_REPO.
#   INSPECTOR_REPO          (required) owner/name for `pr-<n>` envs.
#   BACKEND_REPO            (optional) owner/name for `pr-be-<n>` envs.
#   BACKEND_GITHUB_TOKEN    (optional) Reads PRs in BACKEND_REPO. Without it,
#                           or if it can't list PRs, `pr-be-*` envs are left
#                           alone.
#   STAGING_WORKOS_API_KEY  Needed to deregister the preview URL. Without it
#                           nothing is deleted (see below).
#   DRY_RUN                 1 (default) lists what would be reaped; 0 deletes.
#   MAX_DELETIONS           Cap per run (default 50). The rest wait an hour.
#   GRACE_MINUTES           Skip PRs closed more recently than this (default
#                           30) so the close-time destroy job goes first and a
#                           quick reopen isn't raced.
#
# Safety:
#   - Only env names matching ^pr-[0-9]+$ or ^pr-be-[0-9]+$ are considered;
#     production, staging and personal envs never match.
#   - An env is deleted only after a direct GET of its PR says `closed`. Any
#     lookup failure skips the env.
#   - An env with a custom domain is never deleted; previews don't have one.
#   - The preview URL is deregistered from WorkOS staging first, in strict
#     mode. If that can't be confirmed the env is kept and retried next run —
#     deleting it would release the *.up.railway.app name while its redirect
#     URI is still registered.
#   - Anything that stops an orphan from being reaped for a reason other than
#     policy (PR lookup, WorkOS, Railway delete, unreadable backend PRs) fails
#     the run after every env has been tried, so a broken dependency shows up
#     as a red run instead of an hourly no-op.

set -euo pipefail

: "${RAILWAY_API_TOKEN:?RAILWAY_API_TOKEN must be set}"
: "${RAILWAY_PROJECT_ID:?RAILWAY_PROJECT_ID must be set}"
: "${GITHUB_TOKEN:?GITHUB_TOKEN must be set}"
: "${INSPECTOR_REPO:?INSPECTOR_REPO must be set}"

BACKEND_REPO="${BACKEND_REPO:-}"
BACKEND_GITHUB_TOKEN="${BACKEND_GITHUB_TOKEN:-}"
DRY_RUN="${DRY_RUN:-1}"
MAX_DELETIONS="${MAX_DELETIONS:-50}"
GRACE_MINUTES="${GRACE_MINUTES:-30}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAILWAY_ENDPOINT="https://backboard.railway.app/graphql/v2"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# github_get <token> <path> <outfile>  → prints the HTTP status code.
github_get() {
  local code
  code=$(curl -sS -o "$3" -w "%{http_code}" --max-time 30 \
    -H "Authorization: Bearer $1" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/$2" || true)
  echo "${code:-000}"
}

# list_open_prs <repo> <token>  → open PR numbers, one per line. Fails on any
# non-200 page so a partial list can never be mistaken for the full one.
list_open_prs() {
  local repo="$1" token="$2" page=1 out code count
  out="$TMP_DIR/open.json"
  while :; do
    code=$(github_get "$token" "repos/${repo}/pulls?state=open&per_page=100&page=${page}" "$out")
    if [ "$code" != "200" ]; then
      echo "::warning::Listing open PRs in ${repo} failed (HTTP ${code}) on page ${page}" >&2
      return 1
    fi
    jq -r '.[].number' "$out" || return 1
    count=$(jq 'length' "$out") || return 1
    [ "$count" -lt 100 ] && return 0
    page=$((page + 1))
  done
}

# pr_verdict <repo> <token> <number>  → closed | open | recent | error:<code>
pr_verdict() {
  local out="$TMP_DIR/pr.json" code
  code=$(github_get "$2" "repos/$1/pulls/$3" "$out")
  if [ "$code" != "200" ]; then
    echo "error:${code}"
    return 0
  fi
  jq -r --argjson now "$(date +%s)" --argjson grace "$((GRACE_MINUTES * 60))" '
    if .state != "closed" then "open"
    elif (.closed_at | fromdateiso8601) > ($now - $grace) then "recent"
    else "closed" end' "$out"
}

PAYLOAD=$(jq -nc \
  --arg q 'query P($id: String!){ project(id: $id){ environments { edges { node { id name serviceInstances { edges { node { domains { serviceDomains { domain } customDomains { domain } } } } } } } } } }' \
  --arg id "$RAILWAY_PROJECT_ID" \
  '{query: $q, variables: {id: $id}}')
ENVS_FILE="$TMP_DIR/envs.json"
curl -fsS --max-time 60 -X POST "$RAILWAY_ENDPOINT" \
  -H "Authorization: Bearer $RAILWAY_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data "$PAYLOAD" >"$ENVS_FILE"
if jq -e '.errors' "$ENVS_FILE" >/dev/null 2>&1; then
  echo "::error::Listing Railway environments failed:" >&2
  jq '.errors' "$ENVS_FILE" >&2
  exit 1
fi

# One line per preview env:
#   <id> <name> <first service domain or -> <service domain count> <custom domain count>
PREVIEWS_FILE="$TMP_DIR/previews.tsv"
jq -r '
  .data.project.environments.edges[].node
  | select(.name | test("^pr-(be-)?[0-9]+$"))
  | [ .id,
      .name,
      ([.serviceInstances.edges[].node.domains.serviceDomains[].domain] | first // "-"),
      ([.serviceInstances.edges[].node.domains.serviceDomains[]] | length),
      ([.serviceInstances.edges[].node.domains.customDomains[]] | length)
    ] | @tsv' "$ENVS_FILE" >"$PREVIEWS_FILE"

# Read the whole WorkOS redirect URI list once before trusting any "already
# clean" answer from it. The per-env check below relies on that list being
# complete; until 2026-09-25 it silently read only the newest 100 rows. The
# count also lands in the summary, so a dry run shows whether paging works.
WORKOS_REDIRECTS="not checked (no STAGING_WORKOS_API_KEY)"
if [ -n "${STAGING_WORKOS_API_KEY:-}" ]; then
  if ! WORKOS_REDIRECTS=$("$SCRIPT_DIR/workos-cleanup.sh" --count redirect_uris); then
    echo "::error::Couldn't read the full WorkOS redirect URI list; reaping nothing" >&2
    exit 1
  fi
fi

if ! OPEN_INSPECTOR=$(list_open_prs "$INSPECTOR_REPO" "$GITHUB_TOKEN"); then
  echo "::error::Could not list open PRs in ${INSPECTOR_REPO}; reaping nothing" >&2
  exit 1
fi
BACKEND_OK=0
OPEN_BACKEND=""
if [ -n "$BACKEND_REPO" ] && [ -n "$BACKEND_GITHUB_TOKEN" ]; then
  if OPEN_BACKEND=$(list_open_prs "$BACKEND_REPO" "$BACKEND_GITHUB_TOKEN"); then
    BACKEND_OK=1
  fi
fi
if [ "$BACKEND_OK" -eq 0 ]; then
  echo "::warning::Backend PRs can't be read; leaving every pr-be-* environment alone" >&2
fi

is_open() { grep -qx "$2" <<<"$1"; }

TOTAL=0 KEPT_OPEN=0 REAPED=0 DEFERRED=0 FAILED=0 SKIPPED=0
SKIPPED_LINES=""
REAPED_LINES=""

# skip: kept on purpose. fail: kept because something broke; fails the run.
skip() {
  SKIPPED=$((SKIPPED + 1))
  SKIPPED_LINES+="| \`$1\` | $2 |"$'\n'
}
fail() {
  FAILED=$((FAILED + 1))
  SKIPPED_LINES+="| \`$1\` | **$2** |"$'\n'
}

# Read from fd 3 so nothing inside the loop can consume the list via stdin.
while IFS=$'\t' read -r ENV_ID ENV_NAME DOMAIN SERVICE_DOMAINS CUSTOM_DOMAINS <&3; do
  TOTAL=$((TOTAL + 1))
  if [[ "$ENV_NAME" =~ ^pr-be-([0-9]+)$ ]]; then
    NUMBER="${BASH_REMATCH[1]}" REPO="$BACKEND_REPO" TOKEN="$BACKEND_GITHUB_TOKEN" OPEN="$OPEN_BACKEND"
    if [ "$BACKEND_OK" -eq 0 ]; then
      fail "$ENV_NAME" "backend PRs unreadable"
      continue
    fi
  else
    NUMBER="${ENV_NAME#pr-}" REPO="$INSPECTOR_REPO" TOKEN="$GITHUB_TOKEN" OPEN="$OPEN_INSPECTOR"
  fi

  if is_open "$OPEN" "$NUMBER"; then
    KEPT_OPEN=$((KEPT_OPEN + 1))
    continue
  fi
  if [ "$CUSTOM_DOMAINS" != "0" ]; then
    skip "$ENV_NAME" "has a custom domain"
    continue
  fi
  # WorkOS holds one preview URL per env; with several there's no telling
  # which one was registered.
  if [ "$SERVICE_DOMAINS" -gt 1 ]; then
    skip "$ENV_NAME" "has ${SERVICE_DOMAINS} service domains"
    continue
  fi
  # "-" means no service domain: the env never got a preview URL.
  if [ "$DOMAIN" != "-" ] && ! [[ "$DOMAIN" =~ ^[A-Za-z0-9-]+\.up\.railway\.app$ ]]; then
    skip "$ENV_NAME" "unexpected domain ${DOMAIN}"
    continue
  fi
  if [ "$REAPED" -ge "$MAX_DELETIONS" ]; then
    DEFERRED=$((DEFERRED + 1))
    continue
  fi

  VERDICT=$(pr_verdict "$REPO" "$TOKEN" "$NUMBER")
  case "$VERDICT" in
    closed) ;;
    open) KEPT_OPEN=$((KEPT_OPEN + 1)); continue ;;
    recent) skip "$ENV_NAME" "closed under ${GRACE_MINUTES}m ago"; continue ;;
    *) fail "$ENV_NAME" "PR lookup failed (${VERDICT#error:})"; continue ;;
  esac

  if [ "$DRY_RUN" != "0" ]; then
    echo "would reap ${ENV_NAME} (${REPO}#${NUMBER} closed, ${DOMAIN})"
    REAPED=$((REAPED + 1))
    REAPED_LINES+="| \`$ENV_NAME\` | ${REPO}#${NUMBER} |"$'\n'
    continue
  fi

  # An env with no service domain never got a preview URL, so there is
  # nothing registered with WorkOS to remove.
  if [ "$DOMAIN" != "-" ]; then
    if ! WORKOS_CLEANUP_STRICT=1 \
      "$SCRIPT_DIR/workos-cleanup.sh" "https://${DOMAIN}"; then
      fail "$ENV_NAME" "WorkOS redirect URI removal unconfirmed; retrying next run"
      continue
    fi
  fi

  if "$SCRIPT_DIR/railway-retry.sh" "$SCRIPT_DIR/railway-env.sh" delete "$ENV_ID"; then
    REAPED=$((REAPED + 1))
    REAPED_LINES+="| \`$ENV_NAME\` | ${REPO}#${NUMBER} |"$'\n'
  else
    fail "$ENV_NAME" "Railway delete failed"
  fi
done 3<"$PREVIEWS_FILE"

VERB="Reaped" verb="reaped"
if [ "$DRY_RUN" != "0" ]; then VERB="Would reap" verb="would reap"; fi
SUMMARY="### Preview reaper"$'\n\n'
SUMMARY+="${TOTAL} preview environments: ${KEPT_OPEN} kept (PR open), ${verb} ${REAPED}, deferred ${DEFERRED} (cap ${MAX_DELETIONS}/run), skipped ${SKIPPED}, failed ${FAILED}."$'\n'
SUMMARY+="WorkOS redirect URIs read: ${WORKOS_REDIRECTS}."$'\n'
if [ -n "$REAPED_LINES" ]; then
  SUMMARY+=$'\n'"| ${VERB} | PR |"$'\n'"|---|---|"$'\n'"${REAPED_LINES}"
fi
if [ -n "$SKIPPED_LINES" ]; then
  SUMMARY+=$'\n'"| Kept | Why (bold = failure) |"$'\n'"|---|---|"$'\n'"${SKIPPED_LINES}"
fi
echo "$SUMMARY"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  echo "$SUMMARY" >>"$GITHUB_STEP_SUMMARY"
fi

[ "$FAILED" -eq 0 ]
