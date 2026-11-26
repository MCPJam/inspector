---
"@mcpjam/cli": minor
---

Credit refusals now tell agents how to recover, with one action and an exact resume command. When MCPJam credits refuse an `mcpjam cloud eval run` launch, or stop a run partway, and the step is one a person must take (anything but `wait`), the CLI exits `6` (blocked) and `eval status` on the run exits `6` too. Human output prints the one-action `Recovery:` line and a `Resume:` command; JSON carries `resumeCommand`. The resume command is the same launch with `--resume` (a refused launch, reusing the idempotency key) or `--resume --resume-from <runId>` (a stopped run, which reruns only that run's unfinished cases). Running a resume that is refused again prints `Still blocked:` and exits `6`, never retrying on its own.
