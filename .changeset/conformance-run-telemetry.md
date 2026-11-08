---
"@mcpjam/sdk": patch
"@mcpjam/cli": patch
"@mcpjam/inspector": patch
---

Every conformance run now sends one anonymous `conformance_run_triggered` usage event with a `run_source` (`ui`, `cli`, `sdk`, `api`, `github_app` or `benchmark`), so conformance use can be counted in one place. Each surface keeps its own telemetry opt-outs.
