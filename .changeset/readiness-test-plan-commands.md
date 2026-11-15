---
"@mcpjam/cli": minor
---

`mcpjam readiness submission plan show|draft|save|results` works on a submission's test plan. `draft --output <file>` writes a drafted plan to edit; `save --file <file>` saves a plan file (or what `plan show` printed, or `-` for stdin) at `--expected-revision`, which defaults to the revision the file says it was read at and is never guessed; `results` reads what a run's calls showed, narrowed with `--run`, `--tool` or `--status`. `readiness submission run --test-plan-revision <n>` starts a run that also makes the saved plan's calls.
