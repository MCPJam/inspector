---
"@mcpjam/inspector": patch
---

A failing stage now shows you which trials failed there, and what to do next

The stage funnel counted failures; D9's diagnostics carried the human material — the case title, the observed failure string, the tool names, the trace locator, the next action. They lived on different routes, were rendered by different cards, and **nothing joined one to the other**. A reader who saw `response: 2 failed` had no path from that number to the trial it described.

`buildStageFindings` is that join, and it is a lookup rather than an inference: a diagnostic contributes to stage S **iff** its own chain is `verified` and its row for S says `failed`. Not because its failure category sounds like S, not because it is the only failure in the run, and never because a stage needed an example.

**What is never guessed.** A diagnostic with no failed stage row — a setup abort, an evaluator error, an unverified chain, an absent one — goes to a run-level bucket rendered as one line under the cards ("3 non-passing trials are not attributable to a stage"). The contract says a setup abort is a real answer about a run that never reached a stage; putting its error text under a stage nothing measured it at would be the invention this whole join exists to avoid.

**Grouped by the stage row's own `StageReason`** — the same vocabulary D5c's `reasons[]` tallies by — so a group's count can be checked against the tally line directly above it. Groups sort count-descending, tie-broken by `STAGE_REASONS` order; three groups per stage and three trials per group, the rest behind expanders. The model keeps every trial: capping there would make the count and the list disagree, and the count is the thing a reader checks.

**Two population traps, both handled explicitly.**

1. **D9 enumerates non-passing trials only**, while D5c tallies stage failures over every included trial. Under policy v2 a case can pass with a failing trial in it, so a trial can fail a stage and have no diagnostic row at all. Where the tally's `failed` exceeds the attributed diagnostics **under a complete scan**, the section says so: *"2 further stage failures occurred on trials whose cases passed, so they have no diagnostic row here."* Silence would have read as "we found nothing". On a **partial** page the claim is withheld, because there the gap is explained by the paging and stating it would invent a finding out of an unfinished read.
2. When more trials are attributed than the tally counted, that cannot be policy v2 — so the disagreement is **reported and both numbers stand**. The materializer counted the whole run and this counted a page of it; a silently corrected tally would be worse than either.

Every degraded state is its own variant, never an empty "ready": disabled (renders nothing, issues nothing), loading, unavailable (the decision card's own copy discipline — the stage rates stay on screen and it never reads as a finding about the server), `noDecisionDiagnostics` for a legacy or verdict-less run, `runNotTerminal`, and `identityMismatch`, which renders as **nothing rather than an error** because that is what a mid-navigation frame looks like and an alarm for a state that resolves itself trains a reader to ignore it. A provisional document inherits one caveat line. Nothing in the section states a verdict — that stays D9's card's.

**The loop closes on the diagnostic's own `nextAction`**, already authored per failure category in the SDK and carried on every diagnostic, surfaced as "Next: …" under the evidence. No new vocabulary; a group whose trials disagree on one shows none, because picking one would be a guess wearing the contract's authority.

**Wiring: zero new routes, zero new flags, zero extra HTTP.** Both surfaces call `useEvalRunDecisionDetail` with the identical target `RunDecisionSummarySection` already uses, so the shared LRU store makes the second caller a cache hit. The run page offers "View trace" through the existing `onViewTrace` threading; the suite page offers "Open run" via the `onRunClick` it already holds, because deep trace focus exists only on the run page and a button promising it elsewhere would land a reader on a page with nothing opened. Both ride the existing `evaluate-enabled` flag, and both gate on a terminal run — off, or non-terminal, means no request at all, which is what keeps `/evals` and the CI commit detail at exactly zero.

`isDiagnosticTraceable` is extracted from `DiagnosticRow` rather than reimplemented, so the two surfaces cannot drift on which trials offer a link; its three conditions are pinned by their own tests.
