#!/usr/bin/env bash
# SPIKE: build the managed Claude Code runtime bundle the way CI will.
#   build-bundle.sh <adapter-bridge-dir> <out-root> <node-binary>
# Produces <out-root>/claude-code with: verbatim adapter recipe files
# (package.json, pnpm-lock.yaml, pnpm-workspace.yaml, bridge.mjs), the
# Inspector launcher wrapper, a hoisted symlink-free node_modules pruned of the
# unused `@anthropic-ai/claude-code` wrapper, and the Node launcher at bin/node.
set -euo pipefail
ADAPTER_BRIDGE="$1"; OUT_ROOT="$2"; NODE_BIN="$3"
B="$OUT_ROOT/claude-code"; STORE="$OUT_ROOT/.pnpm-store"
rm -rf "$B"; mkdir -p "$B" "$STORE"
cp "$ADAPTER_BRIDGE/package.json" "$ADAPTER_BRIDGE/pnpm-lock.yaml" "$ADAPTER_BRIDGE/pnpm-workspace.yaml" "$B/"
cp "$ADAPTER_BRIDGE/index.mjs" "$B/bridge.mjs"            # verbatim: the provider compares bytes
cp "$(dirname "$0")/bundle-launcher.mjs" "$B/launcher.mjs"  # Inspector-owned loopback wrapper
( cd "$B" && pnpm install --frozen-lockfile --node-linker=hoisted --store-dir "$STORE" --ignore-scripts )
# The SDK resolves its OWN platform package binary; the wrapper package is
# only used by the adapter's `--version` probe, which the translator no-ops.
rm -rf "$B/node_modules/@anthropic-ai/claude-code" "$B"/node_modules/@anthropic-ai/claude-code-*
# pnpm bin shims are symlinks; the digest refuses symlinks and nothing uses them.
find "$B" -type d -name .bin -prune -exec rm -rf {} +
rm -f "$B/node_modules/.modules.yaml" "$B/node_modules/.pnpm-workspace-state-v1.json"
mkdir -p "$B/bin"; cp "$NODE_BIN" "$B/bin/node"; chmod 755 "$B/bin/node"
test "$(find "$B" -type l | wc -l)" -eq 0 || { echo "symlinks remain"; exit 1; }
echo "bundle at $B: $(du -sh "$B" | cut -f1), $(find "$B" -type f | wc -l | tr -d ' ') files"
