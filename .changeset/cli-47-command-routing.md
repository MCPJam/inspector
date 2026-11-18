---
"@mcpjam/cli": patch
---

`mcpjam cloud evals` is now an alias for `mcpjam cloud eval`, and `cloud projects servers list` lists a project's servers like bare `cloud projects servers`. `<group> <unknown-subcommand> --help` now fails with the same unknown-command usage error and exit 2 as the line without `--help`, instead of printing the group's help and exiting 0.
