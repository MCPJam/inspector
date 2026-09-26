#!/usr/bin/env bash
# Best-effort WorkOS deregistration for the PR preview pipeline.
#
# Usage:
#   .github/scripts/workos-cleanup.sh <preview-url>
#   .github/scripts/workos-cleanup.sh --count <redirect_uris|cors_origins>
#
# Example:
#   .github/scripts/workos-cleanup.sh https://mcp-inspector-pr-123.up.railway.app
#
# Requires:
#   STAGING_WORKOS_API_KEY — API key for the staging WorkOS environment.
#
# Removes what the upsert jobs register per preview (pr-preview.yml,
# "Register preview URL with WorkOS staging"):
#   - redirect URI  <preview-url>/callback
#   - CORS origin   <preview-url>
#
# Why raw curl instead of the workos CLI: as of workos@0.12.1 the CLI only
# implements `config redirect add` / `config cors add` — there is no remove
# subcommand, and WorkOS's public API spec documents only the create
# endpoints. The resources are id-addressed (`ruri_*`), and list/delete are
# served on the same paths (used by third-party integrations that manage
# these resources), just undocumented:
#   GET    /user_management/redirect_uris?limit=100  → { data: [{ id, uri, ... }] }
#   DELETE /user_management/redirect_uris/<id>
#   GET    /user_management/cors_origins?limit=100   → { data: [{ id, origin }] }
#   DELETE /user_management/cors_origins/<id>
# Because they are undocumented, every call here is treated as fallible and
# the outcome is reported via workflow annotations either way.
#
# Paging: the lists come back newest-first, and the cursor for the next
# (older) page is `list_metadata.before`. `list_metadata.after` is null on
# the first page. Until 2026-09-25 this script followed `after`, so every
# scan stopped after the newest 100 rows and reported "already clean" for
# anything older. Only a page shorter than the limit counts as the end of
# the list; anything else is reported as an incomplete scan.
#
# `--count` lists a resource end to end and prints how many rows it has. It
# is read-only; the preview reaper runs it first to prove the list can be read
# completely before it deletes anything.
#
# Exit codes:
#   0 — always. This is hygiene on the PR-close path: a missing entry, an
#       unavailable endpoint, or a bad key must never block PR close.
#       Problems surface as ::warning:: annotations instead.
#   1 — only with WORKOS_CLEANUP_STRICT=1, when removal of the redirect URI
#       can't be confirmed: no key, a failed list or delete, or a scan that
#       hit the page cap without a match. The preview reaper
#       (reap-preview-envs.sh) uses this to keep an environment until its
#       redirect URI is known to be gone. The CORS origin stays best-effort
#       even in strict mode — see the call site at the bottom.
#
# WORKOS_CLEANUP_MAX_PAGES (default 50, i.e. 5,000 rows) caps pages scanned
# per resource.

set -uo pipefail

STRICT="${WORKOS_CLEANUP_STRICT:-0}"
MAX_PAGES="${WORKOS_CLEANUP_MAX_PAGES:-50}"
PAGE_SIZE=100
WORKOS_API_BASE="${WORKOS_API_BASE:-https://api.workos.com}"

# list_all <resource> <outfile>
#   Writes every row of the resource to <outfile>, one JSON object per line,
#   following the `before` cursor until a short page. Returns 1 if the end of
#   the list wasn't reached (HTTP failure, page cap, or a full page without a
#   usable cursor), so a partial list can never pass for the whole one.
list_all() {
  local resource="$1" out="$2" before="" page=0
  : >"$out"
  while [ "$page" -lt "$MAX_PAGES" ]; do
    page=$((page + 1))
    local url="${WORKOS_API_BASE}/user_management/${resource}?limit=${PAGE_SIZE}"
    if [ -n "$before" ]; then
      # Cursors are WorkOS object ids (URL-safe); no escaping needed.
      url="${url}&before=${before}"
    fi

    local resp_file http_code rows next
    resp_file="$(mktemp)"
    # On connection failure curl still emits "000" via -w, so don't append
    # a fallback code — just tolerate the non-zero exit and default if empty.
    http_code=$(curl -sS -o "$resp_file" -w "%{http_code}" --max-time 30 \
      -H "Authorization: Bearer ${STAGING_WORKOS_API_KEY}" \
      "$url" || true)
    http_code="${http_code:-000}"
    if [ "$http_code" != "200" ]; then
      echo "::warning::WorkOS ${resource} list failed (HTTP ${http_code}) on page ${page} — scan incomplete" >&2
      rm -f "$resp_file"
      return 1
    fi
    if ! rows=$(jq '.data | length' "$resp_file" 2>/dev/null); then
      echo "::warning::WorkOS ${resource} page ${page} was not the expected JSON — scan incomplete" >&2
      rm -f "$resp_file"
      return 1
    fi
    jq -c '.data[]' "$resp_file" >>"$out"
    next=$(jq -r '.list_metadata.before // empty' "$resp_file" 2>/dev/null || true)
    rm -f "$resp_file"

    if [ "$rows" -lt "$PAGE_SIZE" ]; then
      return 0
    fi
    if [ -z "$next" ] || [ "$next" = "$before" ]; then
      echo "::warning::WorkOS ${resource} page ${page} was full but gave no new cursor — scan incomplete" >&2
      return 1
    fi
    before="$next"
  done
  echo "::warning::WorkOS ${resource} scan hit the ${MAX_PAGES}-page cap — scan incomplete" >&2
  return 1
}

if [ "${1:-}" = "--count" ]; then
  RESOURCE="${2:-}"
  case "$RESOURCE" in
    redirect_uris | cors_origins) ;;
    *) echo "::error::workos-cleanup.sh --count <redirect_uris|cors_origins>" >&2; exit 2 ;;
  esac
  if [ -z "${STAGING_WORKOS_API_KEY:-}" ]; then
    echo "::error::STAGING_WORKOS_API_KEY is not set" >&2
    exit 1
  fi
  ROWS_FILE="$(mktemp)"
  trap 'rm -f "$ROWS_FILE"' EXIT
  list_all "$RESOURCE" "$ROWS_FILE" || exit 1
  # Distinct ids, so a cursor that repeated rows can't inflate the count.
  jq -r '.id' "$ROWS_FILE" | sort -u | wc -l | tr -d ' '
  exit 0
fi

PREVIEW_URL="${1:-}"
if [ -z "$PREVIEW_URL" ]; then
  echo "::warning::workos-cleanup.sh called without a preview URL — nothing to clean" >&2
  [ "$STRICT" = "1" ] && exit 1
  exit 0
fi
if [ -z "${STAGING_WORKOS_API_KEY:-}" ]; then
  echo "::warning::STAGING_WORKOS_API_KEY is not set — skipping WorkOS cleanup for ${PREVIEW_URL}" >&2
  [ "$STRICT" = "1" ] && exit 1
  exit 0
fi

# delete_matching <resource> <field> <value>
#   resource: redirect_uris | cors_origins
#   field:    uri | origin
#   value:    exact entry value to remove
#
# Lists the whole resource, collects ids whose <field> equals <value>
# exactly, then deletes each id. Collect-then-delete so deletions can't shift
# pagination out from under the scan. A scan that didn't reach the end of the
# list must NOT report "already clean" — it warns instead.
# Returns 1 when removal can't be confirmed; callers decide whether it matters.
delete_matching() {
  local resource="$1" field="$2" value="$3"
  local rows_file ids unconfirmed=0
  rows_file="$(mktemp)"

  if ! list_all "$resource" "$rows_file"; then
    rm -f "$rows_file"
    echo "::warning::Couldn't read every WorkOS ${resource} entry, so '${value}' may still be registered — verify/remove it manually in the staging WorkOS dashboard" >&2
    return 1
  fi
  ids=$(jq -r --arg f "$field" --arg v "$value" 'select(.[$f] == $v) | .id' "$rows_file" | sort -u)
  rm -f "$rows_file"

  if [ -z "$ids" ]; then
    echo "::notice::No WorkOS ${resource} entry matched '${value}' (already clean)"
    return 0
  fi

  local id del_code
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    del_code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 30 -X DELETE \
      -H "Authorization: Bearer ${STAGING_WORKOS_API_KEY}" \
      "${WORKOS_API_BASE}/user_management/${resource}/${id}" || true)
    del_code="${del_code:-000}"
    case "$del_code" in
      2*) echo "::notice::Removed WorkOS ${resource} entry ${id} ('${value}')" ;;
      *)
        echo "::warning::Failed to delete WorkOS ${resource} ${id} (HTTP ${del_code}) — remove '${value}' manually in the staging WorkOS dashboard" >&2
        unconfirmed=1
        ;;
    esac
  done <<< "$ids"
  return "$unconfirmed"
}

REDIRECT_CONFIRMED=1
delete_matching redirect_uris uri "${PREVIEW_URL}/callback" || REDIRECT_CONFIRMED=0
# Best-effort even in strict mode: DELETE on a listed cors_origins id returns
# 404 on every close-time destroy run (e.g. pr-5581, 2026-09-25), so it can't
# gate anything until that endpoint is sorted out. A leftover redirect URI is
# the one that matters — it can deliver auth codes to whoever reclaims the
# *.up.railway.app name; a CORS origin can't.
delete_matching cors_origins origin "${PREVIEW_URL}" || true

if [ "$STRICT" = "1" ] && [ "$REDIRECT_CONFIRMED" -eq 0 ]; then
  exit 1
fi
exit 0
