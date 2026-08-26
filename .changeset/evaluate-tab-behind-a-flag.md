---
"@mcpjam/inspector": minor
---

Evaluate redesign returns as its own tab at `/evaluate`, behind `evaluate-enabled`

The Evaluate landing page, full-page create-suite flow, and run-history suite
overview have now been merged into the live `/evals` tab and reverted twice. The
work is worth keeping; rewriting the shipped tab in place to get it is not.

So it ships as a second tab instead. `/evaluate` is a separate route, a separate
surface, and a separate sidebar item shown alongside Evaluate — nothing a user
without the flag can reach behaves differently. The screens the redesign
rewrote are duplicated under `components/evaluate/` rather than refactored into
shared ones; the queries, mutations, run detail, and case editors are still the
same `components/evals/` modules, so eval behaviour cannot drift between them.

Three shared components take small additive changes instead of a fork:
`SuiteIterationsView` gains an opt-in `suiteDetailOverview` prop (off for every
existing caller), `EnvironmentComposer`'s `slots` prop now actually narrows the
strip and its servers-pill wording is overridable, and `ServerGroupPicker`
accepts a test id and an accessible name for its trigger. Every current caller
renders exactly what it rendered before.

The commit-keyed CI review stays on `/evals/runs`. When the redesign replaces
the original, the old tab and the duplicated directory are deleted together.
