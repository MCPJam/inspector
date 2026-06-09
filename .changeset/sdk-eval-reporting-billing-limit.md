---
"@mcpjam/sdk": minor
---

`EvalReportingError` now exposes an `isBillingLimitReached` boolean, set when the inspector backend rejects an eval iteration because the org has hit its billing entitlement. Lets CLI/harness callers distinguish billing-limit failures from generic reporting errors without parsing error messages.
