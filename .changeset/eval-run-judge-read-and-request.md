---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
"@mcpjam/inspector": minor
---

Judge results are readable, and grading is requestable, from every agent surface.

A suite could be configured to grade and still grade into a place no agent could
see: the run DTO returned no judge results, and nothing outside the app could
ask for grading on a finished run.

`GET …/eval-runs/{runId}` now carries a `judges` envelope — `goalCompletion`
and `groundedness`, each with `status`, `errorCode`, `summary`, `generatedAt`,
`modelUsed`, `threshold` and per-case grades. An envelope rather than a bare
`judge` field because goal completion is one of several advisory graders on a
run, and a third is a new key rather than a reshaped response. `status: null`
means a judge was never requested, which is a different answer from "requested
and graded nothing"; a pending or failed judge carries no cases. `caseKey`
keeps its persisted name — it is the authored-case identity, not a case row id.

New operation `request_eval_run_judge` (`POST …/eval-runs/{runId}/judge`,
`mcpjam eval judge`) requests grading. It declares `risk: "spend"`, is gated
behind an approval proposal on the agent registry, and requires approval on the
in-app chat surface. `force` re-grades; `model` and `threshold` override for one
run; `enable` grades a run recorded while the judge was off — a run's grading
config is pinned when it starts, so enabling the judge on the suite does not
reach an already-recorded run. `enable` needs a platform deployment carrying the
matching backend change; older ones refuse the override rather than silently
grading nothing.

`mcpjam eval status` prints a one-line summary per judge that actually graded,
in `--format human` only. `--format json` output is unchanged in shape beyond
the new `judges` field.
