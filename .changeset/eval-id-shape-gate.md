---
"@mcpjam/inspector": patch
---

Answer 404 instead of 500 when an eval id cannot name a Convex document.

A model polling a grouped eval launch concatenated the run ids it had been
handed and sent them as one `%20`-joined path segment. Convex rejected the
argument before its handler ran, `/v1/projects/:projectId/eval-runs/:runId`
could not classify the rejection, and every retry answered 500 — tagged as our
fault, captured, and paging. The caller recovered on its own within four
minutes by re-requesting each id separately; the alert did not.

Translating the error later cannot fix it. Production Convex redacts the
rejection to `[Request ID: ...] Server Error`, indistinguishable from a genuine
crash, so the shared read translator reads it as an outage and answers 502 —
still a capture, still a page. The `v.id(...)` invariant is only checkable while
the id is still a string, which is before the call goes out.

So the shape is now checked at the HTTP boundary, across every id parameter on
the eval surface — `runId`, `suiteId`, `caseId`, `iterationId`, the optional
`?baseRunId`, and the `suiteId` a launch takes from its request body. A segment
that cannot be a Convex id gets the same 404 and the same sentence a genuinely
missing resource gets, with no outbound call and no Sentry event. 404 rather
than 400 because a distinguishable 400 would tell an unauthorized caller that a
well-formed id names something real and a malformed one does not.

Callers passing well-formed ids see no change, and a malformed id that used to
answer 500 with Convex's internal message now answers 404 without it.
