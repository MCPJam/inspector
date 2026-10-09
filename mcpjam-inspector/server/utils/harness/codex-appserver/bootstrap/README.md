# The in-sandbox bootstrap for the codex app-server transport

`package.json` here is installed **inside the sandbox**, not in this repo. It is
copied in by `getCodexAppServerBootstrap()` alongside its committed
`pnpm-lock.yaml`, the bundled `bridge.mjs` and `host-tools-mcp.mjs`, and then
`pnpm install --frozen-lockfile` runs against it.

## Why the pin is exact

`@openai/codex` is pinned to an exact version, not a range, for three reasons
that all point the same way:

1. The committed protocol snapshot in `.spike-codex-appserver/schema/` describes
   **that** version. A range would let the box run a protocol the adapter was
   not written against.
2. The tool-less model list in `registry.ts` was measured against that binary.
3. The version participates in the bootstrap identity, so a bump forks existing
   sessions cleanly instead of resuming them onto a different runtime.

Bumping it means: regenerate the schema (`.spike-codex-appserver/schema/regen.sh
<version> --diff`), re-run the P5 model matrix, refresh `pnpm-lock.yaml`, and
update `PINNED_CODEX_VERSION` in `bridge/app-server-protocol.ts`.

## The lockfile is committed

`pnpm-lock.yaml` is checked in (with a negation in `mcpjam-inspector/.gitignore`,
which ignores lockfiles globally) and embedded into the generated bundle by
`scripts/bundle-codex-appserver-bridge.mjs`, so the framework installs with the
published adapters' exact literal `pnpm install --frozen-lockfile --store-dir
.pnpm-store`. That fixes the vendor binary by the registry integrity recorded in
the lockfile rather than by whatever the registry serves on the day, and it is
the string the local command translator recognises as a no-op (the verified
runtime pack already holds the graph).

The framework runs bootstrap commands with the bootstrap directory as their
working directory, so the recipe's commands use paths relative to it.

Regenerate after changing `package.json` (pnpm version from
`scripts/local-harness-toolchain.json`):

```sh
cd server/utils/harness/codex-appserver/bootstrap && npx pnpm@10.18.1 install --lockfile-only
```

A change under `codex-appserver/**` changes the bridge bytes, which locally are
the Inspector layer's (`local/inspector-layer.ts`), shipped with the Inspector:
it needs no Codex pack. Only a change to this directory's `package.json` or
lockfile — the vendor graph the pack installs — makes a new Codex pack. (The
hosted bake lock, `harness-bake.lock.json`, still moves with the bridge.)

## No `.npmrc` needed

Unlike the Claude Code bootstrap, `@openai/codex` has no `postinstall` build
script — it is a wrapper that resolves a platform-specific optional dependency
carrying a prebuilt binary. There is nothing for pnpm's build allowlist to
block, which is why none of that machinery appears here.
