---
"@mcpjam/sdk": major
---

Code-first evals now enforce what they declare. **This can fail tests that passed before, by design.**

Three assertions the SDK accepted but never evaluated locally now gate each iteration:

- **`expectedToolCalls` is enforced.** It used to be pure upload metadata — `evaluateToolCalls` was exported but never called by the runner — so the local verdict was your `test` callback alone while the dashboard recomputed the match against the case snapshot. The same iterations could report `accuracy() === 1.0` locally and a failing run in MCPJam. They now agree.
- **`matchOptions` is a real option** on `EvalTestConfig` and `EvalSuiteConfig` (`toolCallOrder`, `argumentMatching`, `maxExtraToolCalls`), layered suite → case with the same resolution the hosted product uses, and validated at construction rather than mid-run.
- **`predicates` run code-first** (`EvalTestConfig.predicates`). The 13-kind predicate engine already shipped in `@mcpjam/sdk/predicates`; nothing outside the hosted runner ever called it. Verdicts gate the iteration and are reported under `metadata.predicates`, so the check chips and cross-run criterion trends light up for code-first runs too.

**`precision()` and `recall()` return real values.** They previously both returned `accuracy()` — the comment said "in a basic eval context, recall equals accuracy" — as did `truePositiveRate()`. They are now micro-averaged over tool-call matches (TP = expected − missing − mismatches, FP = extra + mismatches, FN = missing + mismatches) and **throw when no test in the run declared `expectedToolCalls`**, because there is nothing to compute from; the old silent aliasing is the bug being fixed. `falsePositiveRate()` is deprecated in favor of `unexpectedToolCallRate()` — the fraction of expectation-bearing iterations that made an unexpected call — and keeps its legacy failure-rate value for runs with no expectations.

**Migration.** If a test starts failing, it is telling you its declared expectations were never actually checked. Either fix the expectation, relax it with `matchOptions` (e.g. `{ argumentMatching: "ignore" }`), or drop `expectedToolCalls` if it was only ever documentation. Iterations with no `expectedToolCalls` and no `predicates` behave exactly as before.

Also in this release: predicate transcripts are built from the full span-bearing trace, so `noToolErrors` can actually see tool failures instead of passing vacuously; the synthesized `advancedConfig.steps` is emitted once per case rather than per iteration, so a test whose prompt interpolates a timestamp no longer forks its own hosted history; widget predicates (`widgetRendered`, `widgetRenderLatencyUnder`, `widgetNoConsoleErrors`) are rejected at construction because they need render observations only a hosted run captures, and would otherwise fail every iteration; and per-turn trace summaries now use the canonical matcher, so the timeline can no longer show a turn passing while the iteration verdict says it failed.
