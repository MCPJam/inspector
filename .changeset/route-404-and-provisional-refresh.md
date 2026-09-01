---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

A missing route and a missing run stop looking the same, and a provisional funnel refreshes itself

**`PlatformApiError` now records where its `code` came from.** `STATUS_FALLBACK_CODES` assumes a wire code when an error response carries no `{ code }` envelope, and for 404 that assumption erases a distinction callers need: an API answering `{ code: "NOT_FOUND" }` means the resource does not exist, while a bare 404 with no envelope is usually the route not being there at all. Both arrived as `code: "NOT_FOUND"`, so a caller wanting to fall back on an undeployed endpoint — rather than render "no such thing" — had nothing to branch on. A discriminator built on the code could not have worked.

`codeSource` is `"envelope"` or `"status"`, and it is one signal rather than a verdict: a proxy can strip a body from any status, so it is meant to be read alongside the status, not instead of it. Optional, so an error constructed anywhere else keeps its current shape.

**The stage-analytics reader uses it for the dark ship.** A bare 404 is now `routeUnavailable`, not `notFound`. During a dark ship this is not cosmetic: the run detail was rendering an undeployed route as "this run was never measured" instead of falling back to the legacy funnel it should still have been showing.

**A provisional document now refreshes itself.** A run's analytics are materialized `provisional` while a judge fanout is pending and replaced by a `final` document once it settles. The hook's effect keys on ids and the run's terminal status, neither of which moves at that instant, so a page open across the transition kept showing provisional numbers until someone reloaded.

This is the rule the hook already implements — ask again exactly when the answer can still change — applied to the one transition it did not cover. Bounded and self-terminating rather than a poll: it re-asks only while the document itself says it is unsettled, backs off across four attempts, and stops at `final` or when the budget is spent, so a fanout that never settles costs a handful of reads rather than one per interval forever. A manual `refetch` never consumes the budget, and a re-triggered judge pass gets a fresh one.

Mutation-checked in three directions: dropping the bare-404 branch and forcing `codeSource` to `"envelope"` each fail exactly the test that names it — with the enveloped-404 test beside it as an unchanged control — and removing the refresh effect fails the two tests that assert re-asking.
