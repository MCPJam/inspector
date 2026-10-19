---
"@mcpjam/sdk": major
"@mcpjam/cli": major
"@mcpjam/vitest": minor
"@mcpjam/inspector": patch
---

Require a platform payment before each official eval iteration, including BYOK and runs with uploads disabled. Code-first EvalTest callbacks that issue more than one prompt must declare `billableSteps`; the default is one. Authored corpus and suite-file cases derive this count from their prompt steps. Provider-internal model/tool loops do not add prompt steps.

Callback retries reuse the payment and reset the per-attempt prompt counter. Attempts that exceed the declaration stop before the extra prompt. Using fewer prompts does not automatically refund the declaration. A local crash creates no new refund entitlement; existing server-verified refunds remain unchanged.

Suites share one authenticated start and retain payment receipts through reporting. A refused payment stops queued work and preserves completed paid results. Deploy the compatible backend and Inspector proxy before publishing these packages; result uploads use receipts to avoid collecting the same fee twice.
