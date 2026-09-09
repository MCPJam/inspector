---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

A grading rule is a `check`, on every surface that accepts one

**One `Predicate[]` travelled under three names a customer types.** The suite
file called it `assertions`, `create_eval_suite`'s inline cases called it
`predicates`, and the API, the UI and `create_eval_case` called it `checks` — so
an agent authored a suite in one word and then edited one of its own cases in
another. `check` is the survivor: it is already the API field name, the UI
section's word by explicit decision, and this SDK's own `CheckPolicy` /
`checkRole` / `checkSeverity` prefix.

Additive everywhere. Old names keep working, and both spellings of one field is
a validation error rather than a silent merge:

- suite file: `cases[].checks`, with `assertions` deprecated and still loading
- `create_eval_suite`: `cases[].checks`, folded onto the wire's `predicates`
- `POST /eval-runs` and `POST /eval-suites`: `tests[].checks`

`predicates` was an accepted public request field that OpenAPI never documented
— it passed only because those items allow unknown properties. It is now
written down and marked deprecated rather than left as a third silent spelling,
alongside `checks` and `matchOptions`.

**`steps[].assertion` is deliberately NOT renamed.** Its type is
`WidgetAssertion | Predicate`, genuinely broader than a check: a `Predicate` is
evaluated against a persisted transcript and can be re-derived months later, a
`WidgetAssertion` against a live DOM and never replayed. The spec now says so
instead.

`decision-labels.ts`, the canonical label file, said "check" in one string and
"assertion" in two. It says check in all three.
