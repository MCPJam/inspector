#!/usr/bin/env bash
# Regenerate the pinned codex app-server protocol snapshot.
#
# The snapshot is the CONTRACT this repo's Codex app-server adapter is written
# against. `codex app-server generate-json-schema` emits ~291 files (3.8 MB), so
# we commit the four union files the adapter actually dispatches on, plus a
# MANIFEST.json of sha256 digests for every generated file — enough to detect
# any upstream change without carrying the whole tree.
#
# Usage:  ./regen.sh 0.152.0          # writes schema/0.152.0/
#         ./regen.sh 0.152.0 --diff   # also diffs it against the newest snapshot
set -euo pipefail

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "usage: $0 <codex-version> [--diff]" >&2
  exit 2
fi
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/$VERSION"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "generating codex $VERSION protocol schema..."
npx -y "@openai/codex@$VERSION" app-server generate-json-schema --out "$TMP"

mkdir -p "$OUT"
for f in ClientRequest.json ServerRequest.json ServerNotification.json ClientNotification.json; do
  cp "$TMP/$f" "$OUT/$f"
done
node "$HERE/manifest.mjs" "$TMP" "$VERSION" > "$OUT/MANIFEST.json"
echo "wrote $OUT ($(ls "$OUT" | wc -l) files)"

if [ "${2:-}" = "--diff" ]; then
  PREV="$(ls -d "$HERE"/*/ | grep -v "/$VERSION/$" | sort -V | tail -1)"
  [ -n "$PREV" ] && node "$HERE/diff.mjs" "$PREV" "$OUT"
fi
