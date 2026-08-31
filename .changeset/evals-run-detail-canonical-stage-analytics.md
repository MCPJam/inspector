---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

A run's canonical stage analytics reach the run detail, behind a flag

Two readings of the same six stages exist, and until now the eval run detail could only show the older one. The legacy rollup is a precomputed pass rate with no reach/measured distinction and no slices. The canonical `EvalStageAnalyticsV1` document carries three rates per stage, named exclusions, and the intent/model/host marginals — it is what the API publishes and what external readers cite. The run detail showed the rollup; the suite page showed the document; the same run therefore read differently depending on where you looked at it.

**New: `GET /v1/projects/:projectId/eval-runs/:runId/stage-analytics`**, with `PlatformApiClient.getEvalRunStageAnalytics`.

A separate read rather than a filter over the suite listing. That listing pages newest-first, so reaching a known run through it costs work proportional to how long ago the run finished, and cannot answer at all once the run falls outside the pages walked. A caller that already knows its run asks for its run.

The route makes the same promises the listing does, and one more of its own:

- The run is read and **project-matched first**, so a valid run id from another of the caller's projects reads as `NOT_FOUND` rather than relying on the backend's fail-soft null.
- The payload is validated with the **refined** schema. The structural one would admit a document with two `overall` slices, or an overall slice disagreeing with the row's own trial count — the invariants every rendered number rests on. A failure is a `502`, never a `200` carrying the bad row.
- The document's `runId` must be **the run that was asked for**. `runId` is only `string().min(1)` to the schema, so another run's document parses perfectly and would otherwise be served under this run's heading.
- **`404` is one answer for two facts** — "this run has no document" and "this run is not visible to you" — deliberately not distinguished. Both mean unmeasured to a reader, and separating them would confirm that a run exists in a project the caller cannot see.

**The UI choice is exclusive: canonical document, or legacy rollup, never both.** The two disagree by construction because their denominators differ, so showing both would leave a reader unable to tell which one is the report card. The states:

| State | Renders |
|---|---|
| flag off | legacy, unlabelled — today's page exactly, and no request is issued |
| in flight | nothing; legacy-then-canonical would flash one set of numbers and replace it with different ones |
| document read | canonical only |
| no document (404) | legacy, labelled as the older rollup |
| route not deployed | legacy, labelled, **silently** — this is the dark-ship window, not a malfunction |
| a real read failure | legacy, labelled, **plus a service note** — swapping quietly to older numbers would hide it |

`notFound` is surfaced as its own `absent` status rather than an error, because otherwise every run that finished before the materializer shipped — most of them — would carry a red service message about nothing being wrong.

The hook is called **once**, in the run detail, and its result passed to the renderer as props. The rail needs the same answer for its own emptiness check, and this wraps a plain `fetch` rather than a Convex subscription, so calling it in both places would issue two HTTP requests per run with nothing de-duplicating them. That emptiness check now counts a canonical document too: the existing probe answers only for the legacy rollup, and would have closed the rail over a run that has a document and no rollup.

`RunDocument` is exported from the suite panel and reused as-is — pure props, no hooks, no queries. Reusing the panel instead would have dragged a suite listing, its paging and its run selector onto a page that has exactly one run.

A run with no `projectId` still gets a funnel. `EvalSuiteRun.projectId` is optional, and with the flag on and the id absent the hook is never asked — it sits at `idle`, which used to read as in-flight and drew *nothing*: not the canonical funnel that was never going to arrive, and not the legacy one that renders fine today. "Never asked" is the flag-off state and now answers the same way — legacy, unlabelled, nothing attempted. Only `loading` suppresses, because that is the only state where legacy-then-canonical would flash one set of numbers and replace it with different ones.

The route binds **both** halves of the document's identity, not one. `runId` and `suiteId` are each only `string().min(1)` to the schema, and the route already holds the authorized run's `suiteId` — which is what the client links on. An earlier revision checked `runId` and left a comment saying the Convex reader cross-checks the suite. It does, but that is the other side of the wire making its own guarantee, and asserting one half of an identity while delegating the other is how the delegated half stops being checked at all the day that reader is swapped. The suite comparison is skipped when the run itself carries no `suiteId`, so an older run shape cannot turn a good document into a `502`.

The two 404s are now byte-identical, not just status-identical. The route promises that "no document" and "not visible to you" are indistinguishable — but `v1ErrorBody` returns its `message` to the caller, and the two paths sent different ones, so anyone holding a run id could read off the bit the matching status codes were hiding. The test that was supposed to catch this compared `body.error?.code`, and the envelope is `{ code, message }` with no `error` wrapper: it compared `undefined` with `undefined` and passed. It now compares the whole body, and asserts the body is non-empty so it cannot pass vacuously again.

`idle` is two states, and only the hook can tell them apart. Making an inactive `idle` render legacy introduced a flash: `active` is computed during render, but the effect that sets `loading` runs after that render commits — so for one frame "never asked" and "asking right now" were the same value, and the run detail drew the legacy funnel before replacing it with canonical numbers. The hook now reports `loading` for an active `idle`, so the slot's branches keep meaning what they say.

Dark until the backend reader is deployed and the flag is enabled.
