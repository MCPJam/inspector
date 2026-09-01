---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

Stage analytics stop printing wire enums at a human

The funnel on the Evaluate suite page rendered `noEvidenceCaptured (3)` and `serverData (4)` — the enums as they travel on the wire. `decision-labels.ts` has held the words for both vocabularies since D9, and `run-decision-summary-presentation.ts` reads them correctly; the stage-analytics model simply never imported them. So the same run described its own failure two different ways depending on which card you were looking at.

`STAGE_REASON_LABELS` and `FAILURE_CATEGORY_LABELS` are now what the panel renders. The wire spelling survives beside the words as a `data-reason` attribute rather than being dropped: it is what a test pins on and what a later join against the same vocabulary matches by, and a downstream match against prose is not a match at all.

Reasons render **one line each** (`3 — nothing eligible for that stage was captured`) rather than comma-joined. The labels are "…because &lt;fragment&gt;" sentences by construction, and three of them spliced with commas reads as one long claim about one population instead of three separate counts. Failure categories stay comma-joined because those labels are noun phrases.

**New: `USER_VALUE_STAGE_QUESTIONS`** — the question each of the six stages answers, prose taken from the normative stage descriptions in `chain.ts`. **`USER_VALUE_STAGE_OUTCOMES`** is its past-tense companion: "Session connected", "Tools discovered", "Usable response returned" — what good looks like at each link, for a surface that wants the delivery story rather than six checkmarks. Only ever shown for a stage measured as **passed**: they are claims about the chain holding, and putting one on an unmeasured stage would state as observed the one thing nobody observed.

**New: `EXCLUDED_TRIAL_DETAIL_LABELS` and `describeExcludedTrialDetail`.** `excludedTrialDetail` — fourteen fine-grained exclusion counts — has been fetched and validated on every document and rendered nowhere. It now sits behind a collapsed disclosure on the run header, because it says the same trials the coarse "Excluded:" line already names, at a finer grain: two lines that look like two findings and are one. The summary names the population first ("3 of 7 trials excluded — why"), and the disclosure is absent entirely when nothing was excluded, since a control that opens onto nothing is a worse answer than no control.

Both new maps are `satisfies Record<…, string>`, so a stage or an exclusion key added to the contract breaks this file until somebody writes the words. The exclusion map's totality test reads `evalStageCoverageDetailSchema.shape` rather than a hand-written key list — a hand list is a second declaration of the vocabulary, and the one that goes stale silently.

No visual restructuring: the same cards, in the same places, saying what they always meant.
