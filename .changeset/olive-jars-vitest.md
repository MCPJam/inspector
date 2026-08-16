---
"@mcpjam/vitest": minor
---

New package: run MCPJam eval suites inside vitest.

`describeEvalSuite(name, suite, options)` registers one `it` per eval case,
plus a final `it` for the gate policy when one is given. `suite.run()` is
called ONCE in `beforeAll` — the suite uploads a single hosted run and
computes one aggregate evaluation-config hash, so running it per test would
produce N of each. Each test is an assertion over that one result, which is
why the timeout that matters is `hookTimeoutMs` (default 300000) rather than
any per-test one.

Deliberately a wrapper, not a vitest Reporter. A reporter observes tests; it
cannot decide what a test is. Evals want the opposite, so failures land on
named tests in every vitest UI, watch mode and CI annotation that already
exists — and a reporter has no seat for the gate, which is a verdict over the
whole run rather than any one case.

A case materialized from a hosted corpus is titled `name [caseId]`, from its
explicit `externalCaseId` and never inferred from the test name, so a failing
test greps back to the dashboard row it came from. `testEval` is the
single-test seat; `planEvalSuite`, `runAndAssertCase` and `gateFailureMessage`
are pure and exported so the naming and failure rules can be asserted
directly.

`vitest` is a peer dependency at `>=3.2.0 <4`, tested at 3.2.4. Vitest 4 is
unvalidated and excluded from the range rather than assumed compatible. The
built tarball is installed into a clean project and exercised by three child
`vitest run` processes on every CI pass — proving a passing suite exits 0, a
failing case exits non-zero naming the case, and a breached policy exits
non-zero with the gate table, which a workspace-internal test cannot show.
