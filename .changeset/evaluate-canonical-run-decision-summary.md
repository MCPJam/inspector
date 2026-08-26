---
"@mcpjam/inspector": patch
---

Evaluate renders the run's own decision instead of re-deriving one

D9 gave every surface one canonical answer about a run — the verdict, the
population its counts are in, the run's authoritative `EvalVerdictDecision`, and
the per-trial chain underneath it. The browser was the last reader still
computing its own: the Evaluate suite run history resolved a verdict from
iteration pass rates, the project Runs table derived one from run status, and
run detail showed KPIs with no answer to "what did this run decide" at all.

Behind `evaluate-enabled`, `/evaluate` now reads
`GET /v1/projects/{projectId}/eval-runs/{runId}/decision-summary` and renders it:

- **Run detail** gains a decision card — verdict and its source, counts with
  their measurement unit named, the v2 validity phase and its reasons, and one
  page of non-passing trials with the first failed stage, the failure category,
  the evidence locator and the next action. Paging appends: earlier pages
  survive a later page failing, iterations are listed once across pages, and
  scans are summed.
- **Suite run history** and **project Runs** show the run's own verdict on
  terminal rows, including `inconclusive` and "no verdict" — two answers those
  columns could not previously express.

What this fixes beyond having one answer:

- Local pass-rate math no longer decides anything a run has already decided. A
  case that passes on threshold with a failing trial under it was being reported
  as a failure; it now reads as the run decided it, with the failing trial still
  shown as evidence beneath the verdict.
- `notEstablished` is kept apart from `inconclusive`. One is the absence of a
  verdict, the other is a verdict the validity phase reached and withheld.
- The server's `diagnostics.complete` is rendered verbatim. When the client has
  followed every cursor it was offered, that is said as a separate, differently
  worded fact — a finished local walk never upgrades a partial page to "these are
  the failures".
- A quarantined stage chain withholds both the first failed stage and the
  failure category, and a version-ahead analyzer is flagged rather than dropped.
- Every word comes from the SDK's label maps, so the browser says "User value"
  and "first failed stage" — never a raw `userValue`, never "root cause".

Reads are bounded by one shared controller: page keys dedupe, a global cap of
four concurrent requests, a bounded LRU, abort on the last subscriber leaving,
and a stale window so asynchronous judge fanout is picked up rather than pinned
to the first answer. Table rows load as they scroll into view, so a 50-row page
is not 50 requests and "Show all" cannot ask for a whole history at once.
Pending and running rows stay lifecycle-only.

The legacy `/evals` tab is untouched: every surface takes the read as an
off-by-default prop, so a flag-off render issues no decision-summary requests at
all.
