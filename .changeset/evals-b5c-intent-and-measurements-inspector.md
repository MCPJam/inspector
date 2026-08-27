---
"@mcpjam/inspector": patch
---

Author a case's analytics `intent`, and record how long each stage took.

The case editor gains an optional Intent field. Clearing it is a real edit —
the editor is the surface that owns the label, so a blank box saves an explicit
clear rather than meaning "no change", which would leave a case permanently
stuck in a funnel somebody wanted it out of. The label is grouping only and
never reaches grading.

`intent` is threaded through the eval run and case routes with the same
omitted/`null`/string rule the SDK uses, so a legacy client that does not
mention it cannot strip a label by accident.

Hosted iterations now also persist `stageMeasurements` beside the user-value
chain, derived from the exact rows being stored, and both judge second passes
post the pair together. Because the chain and its measurements are always
derived and posted together, a judge rewrite can never leave timings vouching
for a chain they did not describe.

Setup signals gain the phase's wall-clock envelope. It is emitted only when
every expected target settled with sound timestamps — a missing observation or
a backwards clock produces no sample at all, since a wrong duration is
indistinguishable from a right one once it is summed into an aggregate.

Requires the backend stage-analytics contract to be deployed first.
