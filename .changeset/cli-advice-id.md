---
"@mcpjam/cli": patch
---

`protocol conformance`, `tasks conformance` and `oauth conformance` take a new `--advice-id <id>` flag, repeatable like `--check-id`, to run only the named advice. Without it, every advice still runs.
