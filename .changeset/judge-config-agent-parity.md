---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
"@mcpjam/inspector": minor
---

LLM as Judge can be turned on from the CLI, the SDK and MCP.

`settings.judge` carried only `enabled` and `model`, and `enabled` already
defaults to `true`. The flag the grader actually gates on is `autoRun`, which
no agent surface exposed — so `mcpjam eval update --judge on` wrote a field
that was already set and graded nothing. `autoRun` and `threshold` are now
part of the public judge settings on `PATCH …/eval-suites/{id}`, the
`update_eval_suite` operation, and the MCP catalog (which picks them up with no
tool-side edit).

`mcpjam eval update --judge <on|off>` writes `enabled` and `autoRun` together,
matching the single switch in the app's suite settings sheet: "turn the judge
on" means "grade my runs", not "make a setting available". If you want the
knobs separately, pass `settings.judge` through `--json`. `--judge-threshold
<0-1>` is new alongside it.

The suite DTO's `judge` block is now consistently RESOLVED — `enabled`,
`model`, `autoRun` and `threshold` all layered over the platform defaults,
mirroring the backend resolver. It used to mix a resolved `enabled` with a raw
`model`, so a suite that never picked a judge model reported
`{ enabled: true, model: null }` — a state that never exists at grading time.

Wire-visible change: `judge.model` stops being `null` for suites that never
picked one; it now reports the model a run would actually grade with. The SDK
type keeps `model: string | null` because older deployments still send null,
and `autoRun`/`threshold` are optional there for the same reason.
