---
"@mcpjam/sdk": minor
---

One authoring vocabulary for grading, shared by the app, the CLI and the docs.

`@mcpjam/sdk/contract` gains `suite-grading-labels.ts`: the words every surface uses for the grading policy, following `decision-labels.ts` exactly — one `Object.freeze({…} satisfies Record<Enum, string>)` per vocabulary, so a member added to `grading-policy.ts` without words breaks the build rather than rendering a wire spelling in front of somebody about to edit a threshold. Four label tables used to disagree: the settings manifest, the review dialog's diff labels, revision history's unlisted-field labels and the rail. "Quality gate" named three different storage keys between them, and `matchOptions` read one way in the manifest and another in the dialog.

**No label names a policy version, and a test asserts it on the strings themselves.** `legacy`, `v2`, `upgrade`, `migrate` and `deprecated` are all forbidden in the rendered words. A suite-wide suite is measured differently, not obsolete, and "legacy" told its owner a fact they cannot act on while hiding the one they must: a suite-wide threshold is one percentage over the whole run and a per-case threshold is a fraction over each case's own iterations. Ten cases, nine always passing and one always failing, passes a 90% suite-wide bar and fails a 0.9 per-case one.

`EVAL_RUN_DECISION_VERDICT_SOURCE_LABELS` changes with it: `policyV2` renders as **per-case grading** and `legacy` as **suite accuracy threshold** — the criterion that decided the run, which is what a reader needs in order to trust the counts beside it. The wire spellings are untouched. This is a visible change to `decisionSummary` rendering in the CLI, the HTML report and the app, and to the `verdictSummaryUnavailable` sentence.

Two composers, `describeEvalPassCriterion` and `describeEvalIterationRule`, exist because the facts are only meaningful together: a threshold without its units is ambiguous between the two scopes, and a suite-wide percentage without its population is ambiguous by a factor of the iteration count. Every surface that renders a criterion in prose goes through them rather than concatenating its own.

`PlatformEvalSuiteSettings`'s documentation now says what each field measures rather than which policy version it belongs to, and `minimumIterations` is documented as a FLOOR that raises a case's own count where `verdictPolicyDefaults.repetitions` REPLACES it — a case at 7 resolves to 7 under a floor of 3 and to 3 under a default count of 3. The MCP tool descriptions for `update_eval_suite` and `get_eval_run` carry the same distinction, including the counterexample, because an agent reading "the v2 replacement for minimumAccuracy" would divide by 100.
