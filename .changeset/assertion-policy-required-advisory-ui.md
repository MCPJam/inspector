---
"@mcpjam/inspector": patch
---

An assertion's policy now reads as **Required** or **Advisory** everywhere the product names it — the scorer table, the judge panel, the Add drawer, the run scores list and the trial scorecard. The two words say what happens to the test rather than what the system does: Required fails the iteration, Advisory is shown on the result and never fails it. The scorer table's Role column is now headed "If it fails".

Warn and Report collapse into Advisory. They never differed by consequence — neither failed the iteration — only by an amber highlight, so a reader had to learn a distinction the verdict never made. `severity: "warn"` is still accepted and still stored on rows that carry it; it no longer names a tier, and a newly authored advisory row no longer writes one. The judge's role control is now two segments regardless of what the judge-severity capability advertises, because there is no third tier left for it to withhold.

Nothing on the wire changes: Required is written as it always was (both policy fields stripped), so a row switched to Required is byte-identical to one authored before roles existed and its configuration revision does not move.
