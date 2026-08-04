---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
---

Schedules and case generation learn about project environments.

`set_eval_suite_schedule` takes an `environment` selector, forwarded as the
schedule's environment pin (`mcpjam eval schedule --enable --environment ...`).
A scheduled run launches exactly one run, so a suite with several attached
environments has to pin one; a suite with exactly one defaults to it. Before
this, a v1 caller simply could not enable a schedule on a multi-environment
suite: the backend rejects an unpinned enable and the route dropped the field.

Passing `environment` with `enabled: false` is now an error rather than a no-op
— disabling preserves the existing pin, so the write would have looked like it
repointed the schedule and done nothing.

`generate_eval_cases` takes an `environment` selector too
(`mcpjam eval cases generate --environment ...`), and generation on an
environment-based suite now discovers tools from the environment's closed server
set instead of falling back to the suite's legacy rollback selection — cases
were otherwise authored against tools the suite's runs never see. `environment`
and `servers` are mutually exclusive here as well.
