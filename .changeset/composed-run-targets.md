---
"@mcpjam/inspector": minor
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
---

Let agent surfaces compose an execution stack, not just name a saved one.

The app's environment composer lets someone start from a saved environment OR
quickly assemble a client/model/computer/skills stack. The stack becomes an
ad-hoc — unnamed, content-addressed — environment, which is precisely what keeps
throwaway combinations out of the project's environment list. Agent surfaces had
no path to it: `create_project_environment` forces a name and adds a permanent
entry someone else then has to reason about, which is the pollution ad-hoc rows
exist to avoid.

`ensure_adhoc_environment` (and `POST /environments/ensure-adhoc`) gets or
creates one from a stack in selector vocabulary. It is deduplicated by CONTENT,
so the same stack always returns the same environment and `created` tells a
caller which happened — the status line cannot, because get-or-create answers
200 either way. `name_environment` promotes one in place, keeping the id every
existing run points at; it is the only promotion path, because the platform's
rename is admin-gated and refuses an unnamed row while promotion is member-gated
and refuses a named one.

`run_eval_suite` and `run_eval_case` gain `compose`, and the CLI gains
`--compose-host` / `--compose-computer` / `--compose-model` /
`--compose-server-group` / `--compose-skill`. A composed stack is not a new
execution channel: it resolves to an environment and launches through the
ordinary environment path, so it inherits the same authoritative resolution and
immutable snapshot. There is deliberately no per-run "override the model"
field — that would be a second, weaker channel with none of those guarantees.

Composing APPENDS the environment to the suite, mirroring what the app's own
composer does, because an environment the suite does not list is one nobody can
re-run from the app afterwards. Both operations say so up front, the appended
write is atomic (`POST /eval-suites/{id}/environments` — the replace door would
silently detach an environment someone else attached in between), and the result
reports what was persisted even when the launch itself fails, so a caller whose
run errored still learns their suite changed and that a retry is safe.
