---
"@mcpjam/inspector": patch
---

Where the chain broke is now a place you can click

The stage funnel was six rows of numbers and zero click handlers. It answered "what were the rates" for all six stages at once, and left "which link actually broke, and how much of the run did it touch" to be reconstructed by eye.

The overall slice is now a row of six numbered cards — Connect → Discover → Select → Call → Respond → Satisfy — each wearing a chip derived from that stage's own tally, with the first break selected automatically and a "What happened" card underneath it.

**The chip vocabulary is five states, and the fourth is the one that matters.** First match wins: some passed and some failed is `mixed` (said before either pure verdict, because "2 of 3 failed" is a different finding from "it failed" and collapsing it loses the population that makes it actionable); anything failed is `failed`; anything measured is `passed`; **nothing measured is never a pass word** — not "passed", not a green tone, not an empty chip that reads as fine — it is the dominant honest state among `notReached` / `notMeasured` / `reachUnknown` / `notApplicable`, in that state's own words and in a neutral tone. An amber chip there would send a reader to fix something nothing observed. A unit test walks all 81 combinations of the four not-verdicts and asserts none of them produces a pass kind, a success tone, or a pass word.

A passing card reads its stage's outcome phrase — "Session connected", "Tools discovered", "Usable response returned" — so the row tells the delivery story rather than reporting that six checks ran.

**Auto-selection opens the FIRST break in chain order**, because a failure at `selection` explains the `notReached` at `call` after it, and opening on the later card would put a reader in front of a consequence and call it a finding. A run with nothing broken opens nothing: there is no "what happened" to answer, and auto-opening anyway would manufacture a question the run did not raise. Clicking the open card closes it.

The detail card carries the stage's question from `USER_VALUE_STAGE_QUESTIONS`, the same three rates (`RateCell` is imported from the panel, not re-implemented — a second renderer is a second place for a zero denominator to become a `0%`), its per-stage exclusions, its latency with unit and basis, and a slot for the trial evidence a later change fills.

The panel says the boundary in its own words: *"Stage health explains the request-delivery path; it does not determine the evaluation verdict."* Without it a `failed` chip on a run whose verdict is `passed` reads as a contradiction, when in fact policy v2 lets a case pass with a failing trial in it.

The full three-rate table for all six stages, the intent/model/host marginals and the Setup block keep their markup **verbatim**, now behind collapsed disclosures — the cards answer "where did it break", and a reader who has not yet found the break is not asking whether it differs by host. Every existing `data-testid` is preserved, so the honesty-rule tests still pin the same nodes.

Selection is local state held by `RunDocument` itself, so both mounts — the suite panel and the run-detail slot — inherit the behaviour without either knowing the other exists, and a run switch resets it rather than opening a stage the new run may not have broken at.
