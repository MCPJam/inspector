---
"@mcpjam/inspector": patch
---

`npx @mcpjam/inspector` now writes errors and warnings to stderr. With `--json` it prints no banner and writes one `{"event":"ready","url","port"}` line to stdout when it is ready; startup failures are a `{"event":"error","message"}` line on stderr.
