---
"@mcpjam/inspector": patch
---

Eval runs now spend the budgets their launch froze, rather than re-resolving the platform defaults.

`startTestSuiteRun` resolves the ladder — suite authored values, lowered by the org's ceilings, defaulted by the platform — and returns the frozen object alongside stamping it on the run row. The runner reads it off that response and never re-reads the suite.

Reading the response rather than the suite is the whole point. A run that re-derived its budgets would change what it may spend the moment someone edited the suite mid-flight, and two iterations of the same run could end up bounded differently. The launch decides; everything downstream only carries the decision.

A backend that predates the field returns nothing, which the runner reads as "resolve the platform defaults" — the same code path, differing only in which rung each field came from. So this is safe to deploy in either order.
