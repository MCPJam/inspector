---
"@mcpjam/cli": minor
---

`mcpjam readiness submission run --wait` and `mcpjam readiness submission results` now judge the run under the submission's check gate: they exit 0 when ready, 1 when a check in the gate failed and 3 when a check in the gate has no current result, the run did not complete or the results could not be read. The JSON on stdout carries the `verdict` (with the gate it applied), and stderr names the gate and lists the checks a hosted run cannot check, with the reason. A check moved to warn only still shows in the results; it no longer fails the run. `results` used to exit 0 whatever it read.

`mcpjam readiness submission gate <submission>` chooses which checks fail a run: repeatable `--fail-on <id>` and `--warn-only <id>` move each named check to that list and keep the earlier choices, and `--clear` starts from the directory's blocking checks. The gate is saved against the revision it was read at; if someone saved another gate in between, the command refuses with the gate as it is now, and running it again applies the change to that gate.
