---
"@mcpjam/inspector": patch
---

The judge's displayed boundaries stay distinct from each other, not just from the score

Follow-up to the precision fix. It chose a rendering precision by comparing each boundary with the **score** — and never the boundaries with each other. So a `fail` verdict with a 0.7001 threshold and a 0.6999 partial floor rendered both as `0.7` while the score sat far from either, collapsing the partial band's configured width in the one line whose job is to show it.

Precision is now chosen so that every *pairwise-distinct* displayed value stays distinguishable. Equal values still render equal, and the six-decimal cap still holds — past that a judge score is float noise and an unreadable line explains nothing.

Mutation-checked: reverting to the score-only comparison fails exactly the new test.
