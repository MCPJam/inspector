---
"@mcpjam/cli": patch
---

Keep `--format json` output parseable when a dependency logs mid-command. The MCP client's `console.debug` notice for servers without the `resources` capability now goes to stderr instead of landing ahead of the report on stdout.
