---
"@mcpjam/inspector": patch
---

Pass or fail is organized by the stage each grader measures

**The settings page described its storage, not its measurement.** Tool calls,
Default checks, Minimum accuracy and LLM as Judge sat as four unrelated rows in
the order the fields happen to be stored. A person could read the page top to
bottom and still not answer the question they came with: which parts of my
server does this suite actually check? Those graders now sit under the six
links of the user-value chain — connection, discovery, selection, tool call,
response, user value — each group naming the question it answers and listing
what will grade it. The controls are the same controls, wired to the same
draft; only where a reader finds them changed.

**An unmeasured stage now says which kind of nothing it is.** Connection,
discovery and the tool call have no authorable grader on this page — the runner
measures them on every trial — so "no grader" there would read as a gap
somebody should close. Those three say "Measured by the runner"; selection,
response and user value say "No grader". Neither borrows `notMeasured`, which
is a run-state word for a stage nobody observed, and settings has observed
nothing at all.

**The tool-call matcher was filed under one stage while measuring two.** Order
and extra calls are about which tool the model reached for; argument matching is
about whether the call it made was usable. They now appear under Selection and
Tool call respectively, with the one editor saying where its third field lands.

**Verdict policy v2 had no controls at all.** A v2 suite showed the legacy
percent, which decides none of its runs. The Policy row now renders whichever
policy the suite is actually on — never both, because a page showing a percent
beside a fraction asks a reader to work out which one counts — and a v2 suite
gains a Validity row for the three ceilings that separate "inconclusive" from
"failed". Thresholds are stored and sent as fractions throughout; typing 80
drafts 0.8, and the percent exists only in front of the reader.

**Budgets read as two unrelated checks.** A token ceiling and a turn ceiling
both file at user value analytically, but sitting beside "did the answer contain
the right thing" made none of the three legible. They have their own row now,
still authored in the one Checks editor with everything else.
