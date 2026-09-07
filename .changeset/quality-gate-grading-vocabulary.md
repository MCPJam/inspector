---
"@mcpjam/inspector": patch
---

The Grading tab now says Quality gate, Scorers, and Judges

**"Pass policy" was not a term anyone recognizes.** The suite settings Grading
tab called the verdict block Policy, the authored predicates Checks, and the
grouping Pass or fail. Operators already talk about `mcpjam cloud eval gate`
and gate waivers; the page now uses that vocabulary. The rail is Quality gate /
Scorers / Judges. The case-threshold hint is the exported
`QUALITY_GATE_THRESHOLD_HINT`, so later quality-gate rows cannot drift from it.

**The rail still listed every user-value stage, including three with nothing
to configure.** Connection, discovery, and tool call said "nothing to
configure" while the real editors sat under Checks. Those stage jump links are
gone. The `[data-stage-group]` anchors stay so the scorer table can still
group rows under the chain. Stages the runner observes now say so in those
words, never "not measured".

**Dead collapsed-row helpers were still shipping next to the tabbed page.**
`SuiteGradingChain` and `SettingSummaryCell` had no mounts. The summary module
keeps the sentences the draft and GitHub Checks row still speak and drops the
rest, including `describeGradingDefaults`.
