---
"@mcpjam/cli": patch
---

`conformance run` now takes the same settings as the single-suite commands, so running every suite at once checks what the app's run-all checks. It adds `--protocol-version` (one version for the whole run), `--check-id` and `--advice-id` (each ID goes to the suite that owns it), `--check-timeout`, the protocol tool flags (`--fixtures-file`, `--fixture-tool`, `--fixture-prompt`, `--log-probe-*`, `--log-filter-*`, `--input-required-*`) and the Tasks tool flags (`--tool-name`, `--tool-args`, `--check-overrides`, `--input-responses`, `--poll-timeout`). An ID or flag for a suite the run leaves out is a usage error.
