---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
"@mcpjam/inspector": minor
---

Minimum iterations is settable from the SDK, CLI and MCP.

The suite settings sheet's per-case iteration floor — every case runs at least
N times, `max(case.iterations, minimumIterations)` — had no representation
outside the app. It is now `settings.minimumIterations` on
`PATCH …/eval-suites/{id}` and on `update_eval_suite`, and it appears on the
suite detail.

`null` clears the floor, matching the platform's own `minIterations` contract
exactly rather than inventing a second way to say "no floor". On the CLI that
is `mcpjam eval update --min-iterations off`; `--min-iterations <1-10>` sets
one. A value outside 1–10, or a non-integer, is refused before the write.

`null` on the read means no floor, which is the suite's real state rather than
a stand-in for 1: a floor of 1 and no floor produce identical runs today, but
only one of them is something the user chose.
