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

Dark until the backend reader is deployed and the flag is enabled.
