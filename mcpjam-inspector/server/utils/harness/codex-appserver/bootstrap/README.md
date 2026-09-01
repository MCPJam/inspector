# The in-sandbox bootstrap for the codex app-server transport

`package.json` here is installed **inside the sandbox**, not in this repo. It is
copied in by `getCodexAppServerBootstrap()` alongside the bundled `bridge.mjs`
and `host-tools-mcp.mjs`, and then `pnpm install --frozen-lockfile` runs against
it.

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

## Why there is no lockfile committed here yet

`pnpm install --frozen-lockfile` needs one. Generating it requires a pnpm that
can reach the registry, which this repo's CI does but a sandboxed authoring
session does not. Until it is generated, `getCodexAppServerBootstrap()` installs
WITHOUT `--frozen-lockfile`, which resolves the exact pin above and is safe — the
dependency has no ranges to drift. Generate it with:

```sh
cd server/utils/harness/codex-appserver/bootstrap && pnpm install --lockfile-only
```

then add the lockfile to the bootstrap files and restore `--frozen-lockfile`.
The repo's root `.gitignore` ignores `pnpm-lock.yaml` globally, so it needs a
negation entry when it lands.

## No `.npmrc` needed

Unlike the Claude Code bootstrap, `@openai/codex` has no `postinstall` build
script — it is a wrapper that resolves a platform-specific optional dependency
carrying a prebuilt binary. There is nothing for pnpm's build allowlist to
block, which is why none of that machinery appears here.
