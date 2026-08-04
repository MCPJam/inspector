---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
---

Suite environment attachments are writable from the API, SDK, and CLI.

New `set_eval_suite_environments` operation — `{ project?, suite, environments }`
— replaces a suite's attached project environments outright, or detaches them
all with `null`. This was the missing half of environment-scoped evals: the
attachment list was readable but only the web UI could set it, so an API caller
could not get a suite into the state that makes `run_eval_suite --environment`
work.

CLI: `mcpjam eval environments set --suite <s> --environment <e...>` and
`mcpjam eval environments clear --suite <s>`.

Selectors resolve from a single project listing rather than one lookup each, so
a ten-environment set is one round trip and every selector sees the same view of
the project. Duplicates are detected after resolution, which catches the case a
string comparison misses: the same environment named twice, once by id and once
by name.

An empty array is rejected rather than treated as a clear, mirroring the
backend contract exactly — `null` is the clear.
