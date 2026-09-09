---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

Add the `noEndingQuestion` observation, and produce `endedWithQuestion` for every trial

`noEndingQuestion` reports when the final assistant message's last non-empty
line ends with a question mark. It is an **observation** — a heuristic that
cannot tell an offer from a request for missing input — so it is Warn/Report
only: the schema refuses a gating one and the role control does not offer Gate.

The same helper now writes `metadata.endedWithQuestion` on every trial, whether
or not the check is authored, which closes the run-level route fact that has
reported `notMeasured` since it shipped.

The v1 check-writing routes now reject an unknown check `type` with a 400
instead of persisting one that fails closed as "unknown predicate type" on
every trial of every later run.
