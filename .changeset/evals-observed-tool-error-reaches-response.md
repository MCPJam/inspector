---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

An observed tool error reaches `response`, even when the case authored nothing about tools

A case can author only transcript predicates — nothing about tools at all — and still have a tool fail on the server during the run. `response` was `notApplicable` for such a case, because applicability was decided purely from what the case authored. So when `failOnToolError` failed the trial on exactly that tool error, the chain had **every applicable stage green and no row able to say why the verdict was red**.

That is the shape of a disagreement class found in prod: the legacy verdict failing on a recovered tool error the chain could not represent. It was never a verdict bug — it was a chain that had no vocabulary for what happened.

An observed errored tool call now makes `response` measurable on its own, filing `failed / toolError` under `serverData` like any other server-answered error. Applicability and the deriver share one predicate (`hasObservedToolFailure`) rather than two copies of the condition, so a stage cannot be switched on by one rule and then found empty by the other.

Two boundaries are deliberate. A span carrying an `mcpErrorCode` never reached the server's handler, so it stays a setup fact and does **not** turn the stage on — attributing our own transport failure to the server is the mis-attribution this module exists to prevent. And a case with no tool failure at all is unchanged: `response` stays `notApplicable`, because there is still nothing for it to decide.

This is the one evidence-driven entry in the applicability table, and it is a _positive observation_ rather than a gap, which is what keeps the surrounding rule intact: a stage turned on by observed evidence cannot then be reported as an evidence gap, because the deriver holds the very span that turned it on.

Analyzer 6 → 7. `STAGE_REASONS` does not move (`toolError` already existed), so the backend mirror needs no re-pin.
