---
"@mcpjam/cli": patch
---

The CLI can now name the tools that more conformance checks call, like the app can. `protocol conformance` takes `--input-required-tool` and `--input-required-args` for the 2026-07-28 undeclared capability check, plus `--log-filter-tool`, `--log-filter-args` and `--log-filter-level` to give the log level advice its own tool. `tasks conformance` takes `--check-overrides <json>` to use a different tool for some checks.
