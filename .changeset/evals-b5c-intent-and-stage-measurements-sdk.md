---
"@mcpjam/sdk": patch
---

Carry a case's analytics `intent` end to end, and ship the measurements a
stage chain was measured with.

`intent` is a grouping label — stage analytics slices funnels by it, and no
verdict, threshold or assertion ever reads it. It is accepted on
`EvalTestConfig`, on the suite-file case schema, on the platform case
operations, and on `EvalResultInput`, with one rule spelled the same way at
every boundary: an OMITTED intent preserves whatever is stored, `null` clears
it, and a string sets it.

The two halves of that rule are not symmetric, on purpose. An authored FILE
carries a string or omits the key — it has no `null` of its own, because a
file's absence is what the CLI reconciler turns into the explicit clear. A
code-authored reporter is the opposite: it always speaks, sending a normalized
string or an explicit `null`, because a case authored without a label IS
unlabelled. Only a pre-intent SDK stays silent, and only that silence
preserves a label somebody set in the UI.

Labels are normalized and length-checked at construction rather than at
ingest, so an unusable one is an authoring-time error instead of a case that
quietly stops appearing in the funnel it was labelled for.

Also adds `attachStageMeasurements`, the one helper both producers use to
derive per-stage reach and latency from a chain's SERIALIZED rows — so the
stored chain and the timings that describe it can never come from two
different derivations. Both chain-serializing result mappers now emit it.

Requires a backend that accepts these fields: Convex argument validation is
strict, so an intent-bearing payload sent to a deployment without the contract
has the whole upload rejected rather than the field dropped.
