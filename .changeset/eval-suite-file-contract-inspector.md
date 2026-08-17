---
"@mcpjam/inspector": patch
---

`shared/steps`, `shared/scripted-steps` and `shared/probe-config` now re-export
the canonical step union from `@mcpjam/sdk/contract` instead of defining it.

The union is part of the evaluation contract — it is what a suite file carries
and what the hosted API accepts — and the SDK's new suite-file schema reuses it.
The SDK cannot import this app (the dependency direction is shared → sdk), so
leaving the definition here would have meant a hand-mirrored copy inside the SDK:
a third sibling beside this file and the Convex validator, guaranteed to drift.
The definition moved; these modules re-export it.

No consumer changes: all ~55 importers of `shared/steps` are untouched, the
existing shared step tests pass unmodified, and a new test asserts referential
identity (`sharedSteps.testStepSchema === contract.testStepSchema`) so a copy can
never quietly replace the re-export. `WIDGET_ASSERTION_LABELS` deliberately
stayed behind — display copy is not contract, and the SDK has no business
shipping this app's wording.

Also: exported SDK test files now emit the case's declared `id` (required by
`@mcpjam/sdk` 5.0), using the dashboard case's own id so an exported code-first
test joins back to the same hosted history rather than starting a new one.
