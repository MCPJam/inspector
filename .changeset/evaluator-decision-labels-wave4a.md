---
"@mcpjam/sdk": patch
---

Say "assertion" and "iteration" in two decision labels.

`STAGE_REASON_LABELS.predicateFailed` was "a check on the result did not hold"
and `FRICTION_NOT_MEASURED_REASON_LABELS.evidenceIncomplete` was "the evidence
for this trial has a known hole". They are now "an assertion on the result did
not hold" and "the evidence for this iteration has a known hole", which is the
vocabulary the SDK itself already uses for `assertion()` and the one
`EVAL_RUN_MEASUREMENT_UNIT_LABELS` already renders `measurementUnit: "trial"`
as.

Display strings only. The wire values `predicateFailed`, `evidenceIncomplete`
and `measurementUnit: "trial"` are unchanged, and nothing that reads them
changes behaviour.

These labels are printed by every surface, so the forks pinned to them move in
the same commit: `surface-core/src/copy.js`, the `user-value-chain-glossary`
skill and its generated worker bundle, and the `openapi.json` descriptions the
spec ratchet requires to quote them verbatim.
