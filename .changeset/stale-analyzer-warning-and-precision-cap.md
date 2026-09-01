---
"@mcpjam/inspector": patch
---

Two claims that stayed on screen after they stopped being true

**A chat session kept warning "Derived by a newer analyzer" forever.** `analyzerVersionAhead` is stamped by the backend at the moment a chain arrives, and raising a version constant does not rewrite stored rows — so a session derived during a window when this build lagged its producer carried that amber warning permanently, long after the build caught up.

The version it was derived at sits on the same object, so the warning is now derived from it rather than read out of storage. Self-healing for any future window and needing no migration: the claim goes false the moment it stops being true. This mirrors what the SDK's own `assembleChain` already does for eval runs, and what `checkStageOutcomes` was fixed to do backend-side. The stored boolean survives only as a fallback for rows written before the version was recorded, so nothing that was flagged loses its warning.

The existing test asserted the defect: its fixture is stamped at analyzer 5 with the stored flag set, and against a build at 8 it expected the warning to show. That is how the stale flag survived review, and it is why the replacement test now pins both directions — warns when genuinely ahead, stops warning once caught up.

**The judge's score line could print two different numbers as equal.** `showAgainst` grows precision until every pairwise-distinct value is distinguishable, capped at six decimals — past that a judge score is float noise. But the cap fell through to the six-decimal rendering *anyway*, so values differing beyond it rendered identically: "scored 0.7 against a 0.7 threshold" for numbers that were never equal. That is the exact contradiction the function's own docblock says it exists to prevent, reintroduced at its boundary.

Values still colliding at the cap are now marked approximate (`≈0.7`). Marked per value, not blanket — a number the reader can trust should not be made to look uncertain — and genuinely equal values are left unmarked, because they *are* equal and a marker would make a true statement look doubtful. The six-decimal policy is unchanged.

Both mutation-checked: reverting the derivation fails the warn-when-ahead and stop-when-caught-up tests in opposite directions; reverting the cap fails only the test that names it, and a blanket marker fails only the test that says which values get one.
