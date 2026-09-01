---
"@mcpjam/inspector": patch
---

Every failing trial now shows its own user-value chain, as cards

The run-level funnel answers "how much of this run was measured, and where did it stop". The question a reader actually arrives with is narrower: **this** trial did not deliver value — how far did it get, and why. That answer already existed and was rendered as six lines of flat text inside a collapsed diagnostic row: `Connection: passed`, `Response: failed — the server reported a tool error`.

It is now the same six numbered cards the suite page uses, reading left to right, with a "what happened" card underneath the one a reader selects. The chain opens on the stage the contract named as the first failure, so a reader lands on the break rather than hunting for it.

**A trial is not a population, and the card row says so.** The aggregate chip counts (`failed in 2 of 3 measured`); a trial's chip states (`failed`). There are no rates on a trial's card — "100% (1/1)" over a single observation is a statistic manufactured from one trial — and no latency, which is deliberately not a field on a stage row. What a trial's card carries instead is what a trial actually has: one state, one reason, and that row's own evidence.

**The reason stays off the chip and on the detail card.** Some reason labels are whole sentences, six cards at their minimum width would wrap into unreadable columns, and — the part that matters — keeping the chip to the state word keeps the "never says passed when nothing was decided" invariant total over the five states rather than dependent on the twenty-nine-member reason vocabulary. Two reason labels contain the word "made", which that invariant's own regex matches.

**Which card opens is a UI choice; where the chain stopped is the contract's.** The default selection is `firstFailedStage`, read from the chain and never re-derived by scanning rows — the day a second derivation disagreed, the UI would be the one that was wrong while looking authoritative. When the contract established no failed stage at all, the card that opens is the first non-passing row carrying a reason: that is the setup-abort and policy-block shape, where every stage reads `not measured` and the single sentence explaining the trial would otherwise sit behind a click nobody knows to make.

A withheld (`unverified`) or absent chain renders its existing notice and no cards. An empty six-card row would read as measured, which is exactly what those two states exist to prevent.
