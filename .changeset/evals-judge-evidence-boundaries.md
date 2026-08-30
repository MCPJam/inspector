---
"@mcpjam/inspector": patch
---

Judge evidence names every boundary the band turned on, and never rounds onto one

Two review findings, both about a line of evidence failing to support the claim beside it — which is the one job evidence has.

**The partial floor was never named.** A `partial` or `fail` band is settled by the threshold *and* the partial floor together, but the evidence line mentioned only the threshold. A score of 0.5 against a 0.7 threshold with a 0.6 floor read as a plain miss and said nothing about why it failed rather than landing in the partial band. The floor is now included exactly when it is one of the numbers the decision turned on — and left out of a band it did not decide, so a passing row does not carry a number that had no part in its outcome.

**Rounding could contradict the band.** Scores were rendered at two decimals, so 0.699 against a 0.7 threshold produced *"LLM judge scored 0.7 against a 0.7 threshold"* next to a `fail` band. The numbers argued with the label and a reader had no way to tell which was wrong.

Precision now grows only as far as it must: two decimals whenever the values are already distinguishable there, and the first deeper precision that keeps every *different* pair looking different, capped at six — past that a judge score is float noise and an unreadable line explains nothing. Equal values still render equal, so a score exactly on its threshold reads that way, and float noise like `0.42000000000000004` is still trimmed to `0.42`, which is why the rounding existed in the first place.

Mutation-checked: dropping the floor, naming it on every band, and reverting to fixed two-decimal rounding each fail exactly their intended tests.
