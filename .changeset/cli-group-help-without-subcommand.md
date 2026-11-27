---
"@mcpjam/cli": patch
---

Running a command group without a subcommand, such as `mcpjam cloud`, now shows that group's help and exits 2. With `--format json`, the usage error names the command and points at `--help` instead of saying `(outputHelp)`. `mcpjam help <command>` now exits 0 instead of printing a usage error after the help.
