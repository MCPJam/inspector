---
"@mcpjam/sdk": patch
"@mcpjam/cli": patch
"@mcpjam/inspector": patch
---

Protocol conformance: `modern-log-level-filtering` is now the `readiness-log-level-filtering` advice, which costs no points. The spec only says a server "MAY send" logs at or above the requested level, so a pass/fail check was too strict. The advice shows when no logs come back, or when logs come back below the requested level. `logProbe` takes a new `level` (default `warning`). The CLI adds `--log-probe-tool`, `--log-probe-args` and `--log-probe-level`. The app no longer lists the old check. Advice can now be picked per run with the new `readinessIds` option (absent runs all advice, empty runs none, and advice left out sends no probe). Tasks and OAuth take the same `readinessIds`. The app lists each suite's advice in step 2 (Protocol, Tasks, OAuth; Apps has none) with a checkbox each, and the "Log level to request" picker sits on the Log Level Filtering row. The "Authorization Response iss" advice moves from the Protocol suite to the OAuth suite, read from the metadata the OAuth flow already fetches; it now costs OAuth points instead of Protocol points, and the CLI prints OAuth advice. Compatibility: drop `modern-log-level-filtering` from `checkIds` / `--check-id`.
