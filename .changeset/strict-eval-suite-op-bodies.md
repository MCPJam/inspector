---
"@mcpjam/sdk": patch
"@mcpjam/cli": patch
---

`mcpjam eval create/update --json` (and `--file`) now reject unknown top-level keys as a usage error instead of silently dropping them. The MCP `create_eval_suite` / `update_eval_suite` tools publish the same closed input shape.
