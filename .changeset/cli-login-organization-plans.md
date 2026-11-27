---
"@mcpjam/cli": patch
---

`mcpjam cloud login` and `mcpjam cloud whoami` no longer report a `plan` for your account, which said "free" for everyone, including members of paid organizations. Both now list your organizations under `organizations`, each with its `id`, `name` and `plan`. If that lookup fails, `whoami` fails and `login` still succeeds with a warning. Login no longer saves a plan to the auth file.
