---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

Friction signals per trial, and the suspected condition behind them

Two report-only additions to the eval contract, neither of which touches a
verdict, the user-value chain, `failureCategory`, or analytics.

**Friction signals** (`@mcpjam/sdk/contract`, `friction-signals.ts`) are
observable patterns in one trial's tool calls: an identifier a result surfaced
that no later call carried, the same search repeated after it, a retry with
identical arguments, a retry with changed ones, a pagination continuation.
They are SIGNALS, not verdicts — every one has a benign reading, and the
labels say what was seen and stop. Identifier claims are only made where
availability can be PROVEN: message order for the emulated engine, wire timing
for a harness run whose graded call array appends wire-only calls. A trial
that cannot answer that question reports `identifierSignals.notMeasured` and
keeps its retry signals. Persisted signals carry key paths and counts, never
identifier values.

Route facts gain an OPTIONAL `frictionSignals` block per case, with two
denominators: the three adjacency rates over trials whose document is
`measured`, the two identifier rates over the smaller set that also measured
its identifier half. The block is omitted entirely when no trial supplied a
document, so a run whose producer predates the measurement is byte-unchanged.

**The suspected condition** is an advisory per-trial verdict from a backend
judge, rendered here: which server-controlled condition is SUSPECTED of
contributing, plus one remediation naming a server lever. "Suspected" is
load-bearing — only a controlled rewrite could establish cause — and the copy
never says "caused". `unclear` renders as "could not attribute" with no next
step; an unverified verdict renders as "not available"; a trial the judge
never reached renders nothing.

`EvalIteration` gains `frictionSignals`, `frictionSignalsUnverified`,
`suspectedConditionVerdict` and `suspectedConditionUnverified`, all optional
and all absent for every iteration that predates the measurement. An absent
block means UNMEASURED and must never be rendered as zero.
