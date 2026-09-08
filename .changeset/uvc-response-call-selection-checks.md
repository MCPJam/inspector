---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

Response, Tool-call and Selection checks, over evidence the runner already had

The transcript now carries tool results (with a measured size and a capture
completeness flag), per-call durations and the advertised tool inventory, so
twelve new check kinds can answer questions that were previously unanswerable
over data we were already holding: payload size, call latency, result shape,
argument validity against the declared schema, call ordering, and four
narrowly-named observations.

A check that cannot measure now reports `status: "error"` — no value, scorer
unresolved, stage `notMeasured` — instead of a 0 that would attribute a defect
to the server for a measurement we failed to take.

Stage analyzer 11: response- and call-filed check rows are consumed by those
stages instead of falling to user value, and `noToolErrors` moves to Response,
where it stops double-counting a tool error against two stages.
