#!/usr/bin/env bash
# Best-effort WorkOS deregistration for the PR preview pipeline.
#
# Usage:
#   .github/scripts/workos-cleanup.sh <preview-url>
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
# Exit codes:
#   0 — always. This is hygiene on the PR-close path: a missing entry, an
#       unavailable endpoint, or a bad key must never block PR close.
#       Problems surface as ::warning:: annotations instead.

set -uo pipefail

PREVIEW_URL="${1:-}"
if [ -z "$PREVIEW_URL" ]; then
  echo "::warning::workos-cleanup.sh called without a preview URL — nothing to clean" >&2
  exit 0
fi
if [ -z "${STAGING_WORKOS_API_KEY:-}" ]; then
  echo "::warning::STAGING_WORKOS_API_KEY is not set — skipping WorkOS cleanup for ${PREVIEW_URL}" >&2
  exit 0
fi

WORKOS_API_BASE="${WORKOS_API_BASE:-https://api.workos.com}"

# delete_matching <resource> <field> <value>
#   resource: redirect_uris | cors_origins
#   field:    uri | origin
#   value:    exact entry value to remove
#
# Lists the resource (following pagination cursors), collects ids whose
# <field> equals <value> exactly, then deletes each id. Collect-then-delete
# so deletions can't shift pagination out from under the scan. The scan
# stops at the first match: WorkOS rejects exact duplicates (422 "already
# exists"), so one entry per exact value is all that can exist. A scan that
# ends without a match AND without seeing the end of the list (page cap,
# list failure) must NOT report "already clean" — it warns instead.
delete_matching() {
  local resource="$1" field="$2" value="$3"
  local after="" page=0 ids="" scan_complete=0

  while [ "$page" -lt 10 ]; do
    page=$((page + 1))
    local url="${WORKOS_API_BASE}/user_management/${resource}?limit=100"
    if [ -n "$after" ]; then
      # Cursors are WorkOS object ids (URL-safe); no escaping needed.
      url="${url}&after=${after}"
    fi

    local resp_file http_code
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
      break
    fi

    local page_ids
    page_ids=$(jq -r --arg f "$field" --arg v "$value" \
      '.data[]? | select(.[$f] == $v) | .id' "$resp_file" 2>/dev/null || true)
    if [ -n "$page_ids" ]; then
      ids="$page_ids"
      rm -f "$resp_file"
      scan_complete=1
      break
    fi

    after=$(jq -r '.list_metadata.after // empty' "$resp_file" 2>/dev/null || true)
    rm -f "$resp_file"
    if [ -z "$after" ]; then
      scan_complete=1
      break
    fi
  done

  if [ -z "$ids" ]; then
    if [ "$scan_complete" -eq 1 ]; then
      echo "::notice::No WorkOS ${resource} entry matched '${value}' (already clean)"
    else
      echo "::warning::WorkOS ${resource} scan ended after ${page} page(s) without finding '${value}' — verify/remove it manually in the staging WorkOS dashboard" >&2
    fi
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
      *) echo "::warning::Failed to delete WorkOS ${resource} ${id} (HTTP ${del_code}) — remove '${value}' manually in the staging WorkOS dashboard" >&2 ;;
    esac
  done <<< "$ids"
}

delete_matching redirect_uris uri "${PREVIEW_URL}/callback"
delete_matching cors_origins origin "${PREVIEW_URL}"

exit 0
