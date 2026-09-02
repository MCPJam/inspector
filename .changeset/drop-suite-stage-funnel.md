---
"@mcpjam/inspector": patch
---

The suite page stops opening with an aggregate

The first thing labelled "user value chain" on the suite page was a funnel — a population statistic, sitting above the run history. It was the wrong introduction to the idea. The chain a reader arrives asking about is one request's journey, and the aggregate answers a different, later question.

It also read badly on real runs. On a three-trial suite it showed six green stages over "2 of 3 trials", the excluded one being precisely the trial that broke; on a ten-trial suite it showed `call` and `response` as `applicable=0`, which looks like a gap and only means those cases assert nothing there. The page's most prominent claim was its least reliable.

The per-trial chain now answers "why did this not deliver value", on the run page, the trace pane and the case table. The run-level document still renders on the run page behind its existing flag, where it reads as the follow-up it is.

Removed with the mount: `StageAnalyticsPanel`, `useEvalSuiteStageAnalytics`, `fetchEvalSuiteStageAnalytics` and the panel-state model — the suite-scoped reader had exactly one consumer, and dead code with passing tests is what drifts. `RunDocument`, `RateCell` and `useStageFindings` all stay; the run page uses them.

**Two test files were re-aimed rather than deleted.** The findings tests ran through the panel, and the API tests covered only the suite listing — but their claims were never about which resource was fetched. The findings ones now assert against `RunDocument` + `StageFindingsCard`, the composition the run page actually builds; the API ones now cover `fetchEvalRunStageAnalytics`, which had no wrapper-level coverage at all (its hook test mocks the wrapper). Deleting them would have quietly dropped the guarantees they exist for: auth has one owner, the payload is validated not trusted, identity is bound, and the four failure kinds stay four.
