---
"@mcpjam/cli": minor
---

`mcpjam readiness flows [flow]` lists the directory forms MCPJam can rehearse, or shows one (`--step` for one step). `mcpjam readiness submission create|list|get|set|delete|run|results` keeps a rehearsal of a directory submission for a saved server: `set` takes repeatable `--answer key=value` (the value is read as JSON when it parses, otherwise as text), `--unset key` and `--confirm key`, reads the current revision unless `--expected-revision` is given, and retries a conflict once only with `--retry-on-conflict`. `run --wait` waits for the run and exits 0 when ready, 1 when not ready and 3 when the run graded nothing.
