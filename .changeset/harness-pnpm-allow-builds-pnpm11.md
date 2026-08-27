---
"@mcpjam/inspector": patch
---

Fix the Claude Code harness bootstrap on pnpm 11.

The previous fix wrote only `.npmrc`, verified against pnpm 10 — but pnpm 11
reads none of its settings from `.npmrc`, so every harness bootstrap failed
with `ERR_PNPM_IGNORED_BUILDS` once the changed recipe hash stopped snapshots
from hiding it. Both spellings are now written, plus a second layer that keeps
a skipped build non-fatal so the adapter's own `install.cjs` step can repair
the install if the allow-list setting is ever renamed again.
