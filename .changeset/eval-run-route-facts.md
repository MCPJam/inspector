---
"@mcpjam/sdk": minor
---

Eval runs report tool routes and name-level mismatches, without deciding a verdict

**A run page that could only say pass/fail.** Selection failures have no dominant shape — some trials call nothing, some a subset, some an out-of-catalog tool, a few a one-to-one swap — and the matcher already knew that. Nothing assembled it into a document a dashboard, an MCP tool, or a later experiment could read the same way. `@mcpjam/sdk/contract` now ships `evalRunRouteFactsSchema` and `buildEvalRunRouteFacts`: per-case routes with an opportunity denominator, substitution only for the one-to-one in-catalog shape, negative tests in the routes and out of the mismatch block.

**Report-only, trial-population, no defaults.** Every rate is an `EvalRateMeasurement` so `0/0` cannot render as a number. Counting rules live in the charter: included means completed and graded, names only, `endedWithQuestion` stays `notMeasured` until a producer exists. The golden fixture is the conformance target the backend materializer must match byte for byte.
