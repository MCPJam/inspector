---
"@mcpjam/cli": patch
---

Internal refactor: the nine per-command copies of `addPlatformOptions` / `runPlatformCommand` / `PlatformOptions` collapse into one shared `cli/src/lib/platform-command.ts`. The shared runner is the superset of the variants that had drifted — the execute context always carries `webOrigin` (previously `eval`-only) and the optional external abort signal (previously `projects`-only) — so no command loses behavior. No user-facing changes.
