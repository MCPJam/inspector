# Claude Code vendor pack graph

What a Claude Code runtime pack installs: `@anthropic-ai/claude-agent-sdk`
(and, through its optional dependencies, the platform package that carries the
native CLI it shares a version with), plus the SDK's declared peers at the
versions the adapter's own lockfile resolves them to. Frozen by
`pnpm-lock.yaml`; the pack build installs it with `--frozen-lockfile`.

A security bump may pin a peer ahead of the adapter's lockfile (the MCP SDK is
at 1.31.0 here while the adapter still resolves 1.30.0). Nothing checks peers
against the adapter, so an adapter bump must not move one back down.

The adapter's bridge is **not** here: it is the Inspector layer
(`server/utils/harness/local/inspector-layer.ts`), shipped with the Inspector,
with the MCP SDK, `zod` and `ws` compiled in. So an adapter bump is an Inspector
change, and only a change to this directory makes a new Claude Code pack.

When an adapter bump moves the agent SDK version, the layer bundler refuses to
build (`scripts/bundle-local-harness-layer.mjs`) until this directory pins the
same version:

```sh
# edit package.json (the agent SDK and the peer versions the adapter's
# dist/bridge/pnpm-lock.yaml resolves), then, with the pinned pnpm:
cd scripts/local-harness-pack-recipes/claude-code-vendor
npx pnpm@10.18.1 install --lockfile-only
```
