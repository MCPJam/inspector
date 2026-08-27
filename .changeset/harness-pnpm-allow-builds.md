---
"@mcpjam/inspector": patch
---

Let the Claude Code harness bootstrap install its CLI on modern pnpm.

`@anthropic-ai/claude-code` ships a `postinstall` that fetches its
platform-native binary. pnpm 10 stopped running dependency build scripts by
default, and the computer template installs pnpm unpinned — so on a pnpm that
treats the skipped script as an error (`ERR_PNPM_IGNORED_BUILDS`) the
bootstrap's `pnpm install` aborts, taking the adapter's own `install.cjs`
rescue step down with it, and the harness dies before its first turn.

The bootstrap now writes an `.npmrc` beside the adapter's bundled manifest.
