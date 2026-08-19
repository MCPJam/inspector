---
"@mcpjam/inspector": patch
---

Record who reads an eval iteration's trace through the public API.

The two per-iteration read routes — `GET …/eval-runs/:runId/iterations/:iterationId/trace`
and its `/steps` sibling — served a run's stored transcripts with no trace of
who pulled them. The bulk half of that question was already answerable:
`eval` is a first-class session source type and the OTLP export defaults to
`direct+scenario+eval`, so eval transcripts already flow through the audited
export path. What was missing was the caller walking a run's iterations one at
a time, which bulk-export auditing never sees.

Both routes now report the read to the platform after it resolves, and the row
records the actor, the iteration, the run, and how much came back — never any
part of the transcript.

## Two credentials, two jobs

The report carries both `INSPECTOR_SERVICE_TOKEN` and the caller's Convex
bearer, and neither substitutes for the other. The service token authorizes the
call: writing an audit row on someone else's behalf is privileged, and
possession of it is what says the caller is our deployed server rather than the
public. The bearer names the human, and the platform resolves the actor from
it.

The identity is deliberately not derived here. This server's own view of its
caller is uneven — `mcpjamUserId` is set only on the API-key branch of the
bearer middleware, and the eval v1 routes do not mount `optional-actor` — so
deriving the actor at this layer would have attributed API-key reads and
silently dropped session ones. A trail that is blank for exactly the callers
someone is most likely asking about is worse than an empty one, because it
looks like an answer. `getConvexBearerForRequest` already returns a bearer for
both kinds of caller, and both carry the person's external id as `sub`, so
forwarding it lets one platform path resolve either.

## It cannot fail your read

The report is best-effort and awaited: it runs after the response body is
already resolved, and a platform outage, a slow network, or an
older-than-expected deployment logs once and is swallowed. A `/trace` read that
404s because no trace exists reports nothing at all — a row here means a
transcript actually left the product.

`/steps` behaves differently on purpose, matching the route: a missing envelope
is not a 404 there, so its row carries a trace size only when evidence was
really resolved, and the absence of that field is how the row says "verdicts
only".

**Deploy ordering:** the platform route this calls must be deployed first.
Until it is, the request meets a routing 404, which logs and is discarded —
a soft landing, not a reason the ordering does not matter, since an undeployed
platform means no audit rows at all.
