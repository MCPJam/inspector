---
"@mcpjam/cli": patch
---

The anonymous `cli_command` telemetry event now carries an `outcome`: `ok`, `check_failed`, `error`, `usage_error` or `interrupted`. A command that finishes and reports failing results, such as a readiness check that finds problems, is no longer counted as an unknown error. Unknown commands and invalid options now send a usage-error event that names only the registered command path they matched, or `(unknown)`. A run stopped with Ctrl+C is counted as interrupted, including a forced quit of `tunnel` or `events watch`, which now waits up to 1 second for telemetry before exiting. Use `--no-telemetry`, `DO_NOT_TRACK=1` or `mcpjam telemetry disable` to opt out.
