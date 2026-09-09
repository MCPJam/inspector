---
"@mcpjam/inspector": patch
---

An inconclusive run no longer reads as "Suite Failed"

`PassCriteriaBadge` had no `inconclusive` branch, so a run the platform
declined to decide fell through `passed === false` and rendered a red
"Suite Failed" — on the run header, the run insight rail, and the commit
detail view. That is a defect claim about a customer's server that the run
never observed, and collapsing `inconclusive` into `failed` is the one thing
the verdict policy exists to prevent.

It now renders amber "Inconclusive" (compact) / "Suite Inconclusive"
(detailed), with an aria-label that says the same thing, and without quoting
a pass-criteria threshold that was never applied to the run.
