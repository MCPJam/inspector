---
"@mcpjam/inspector": patch
---

The Evaluate run page leads with what broke and what to do about it.

**One failure, said five times, with the finding missing.** The run page opened
with a pass rate, repeated it in the runs rail, in the run-decision card and in
the triage header, and the one sentence naming the case that failed sat
mid-paragraph behind a "Show more". Meanwhile the panel headed "1 suggested fix"
listed three low-confidence workflow findings, two of them on cases that PASSED,
and the case that measurably failed had no action attached anywhere on the page.

`EvaluateRunContent` inverts that. The verdict word comes first, then one
sentence naming the case, the stage its chain stopped at and the reason, then
the expected and observed tool calls, then "Prompt to improve". Cases are rows
carrying their own verdict, their iteration fraction, where they broke and a
six-cell chain; failures sort first and the first one opens onto its grouped
failures, evidence and a per-group fix prompt. The judge findings keep every row
and move below the failures, closed, under "Worth a look, never required". The
counting caveats keep every word under "How this verdict was counted".

**Nothing is re-derived.** The verdict, the counts and the failing case come
from the canonical decision summary through the same LRU store the existing
decision card reads, so the two surfaces cost one request and cannot disagree
about a run. Chains come from the diagnostics for non-passing iterations and the
iteration read for the rest — both page-capped, so a row whose chains are
incomplete says how many it has rather than showing stages it never fetched.

**A mark is a verdict, and only appears when one was read.** Per-case verdicts
live in `decision.cases[]`, keyed by an identity the platform mints and never
sends back, so `evaluate-case-identity` mirrors its four readable encodings with
a SYNC note to the backend file. The mirror is deliberately partial: the backend
hashes anything outside its id pattern and a browser cannot do that
synchronously, so an unencodable identity mints nothing. Every miss is stated —
a legacy run has no per-case verdict, an unmatched key says so, variants that
disagree get no single mark — and in all of them the iteration fraction stays
grey, because a population is not a decision.

**New page only.** `/evals`, CI and the folded dashboard keep `RunDetailView`,
`RunDecisionSummaryCard`, `AiTriageCard` and the shared findings panel exactly as
they are; the new components are additive files under `components/evaluate/` and
the shared modules gained only new exports. The existing run-detail pane still
renders below the new content on `/evaluate` while the remaining pieces land, so
this commit removes nothing from the page.

Behind `evaluate-enabled`, which stays default-off.
