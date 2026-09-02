---
"@mcpjam/inspector": patch
---

The Evaluate run page reads the contract's stage remedies instead of its own.

`STAGE_REASON_REMEDIES` already answers "what is the one thing to go and
change", keyed on the stage reason for exactly the reason this page needed it:
the coarse failure category cannot tell "an expected tool call was never made"
from "a call was made that the case did not expect", and those want opposite
edits. Its sentences are byte-pinned to the backend's own mirror, so a second
map of the same advice would have drifted from the one the GitHub check writes.

The absence carries as much as the text. That map is deliberately `Partial`,
and `STAGE_REASONS_WITHOUT_REMEDY` names the reasons it omits — a provider
failure of ours, an unverified egress, a stage that was not measured, an
earlier stage having failed, every passing reason. The run page now renders
nothing for those rather than a manufactured next step, because a sentence
there would send a reader after a system the run never implicated.

What the page adds is a voice, derived rather than declared: the two judge
reasons that carry a remedy may only ask the reader to check, since a judge
score is one model's opinion of another's answer. Membership decides that, not
the shape of the reason's name — `judgeObserved`, `judgePending` and
`judgeNotRequested` share the same prefix and carry no remedy at all.
