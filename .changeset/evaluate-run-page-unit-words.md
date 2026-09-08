---
"@mcpjam/inspector": patch
---

The run page counts case variants and trials, and says so

**"6 of 6 cases" beside a Cases list showing 3 is the number contradicting the
page it sits on.** A 3-case suite fanned out over 2 models has 6 CASE VARIANTS,
and a legacy run's counts are TRIALS — the one thing a run page must never call
cases. The verdict hero, the case rows and the failure groups each rendered
`"cases"` and `"iterations"` as literals.

`measurementUnitLabel` from `@mcpjam/sdk/contract` already owns both spellings;
the CLI, the HTML reporter and the decision-summary presentation all use it.
These four Evaluate modules now do too, so a unit word cannot drift from the
contract that decided it:

- the verdict hero's case stat and its caveats
- the case rows' pass strip, stage titles, legacy-run note and open button
- the failure-group headings
- the case workspace's inspect strip, which said `Iter #n` in the same pane
  whose control is labelled Trials
