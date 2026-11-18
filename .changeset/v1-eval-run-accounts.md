---
"@mcpjam/inspector": patch
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
---

Eval runs read through the API now include `accounts`: the account each server used, whether it was personal or the project's, when its token was stored and by whom, when it expires, and whose it was. An account's email is included only when you may see it: a project account's for every project member, a personal account's only for the person who started the run, which for an API key is the key's owner. In human output, `mcpjam eval status`, `eval run --wait` and `eval rerun --wait` print one line per server naming those accounts.
