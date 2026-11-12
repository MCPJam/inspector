---
"@mcpjam/cli": patch
---

`mcpjam cloud server-accounts` manages the accounts a saved server signs in with for hosted runs: `list`, `show`, `set`, `rename`, `default` and `delete`. All take `--server`, and all but `list` take `--account`, by id or name. `set` uploads an access token read from `--access-token-file`, `--access-token-env` or `--access-token -` (stdin) and refuses a token typed on the command line. It takes `--client-id`, and optionally `--refresh-token-file` and `--expires-in`. No command prints a token.
