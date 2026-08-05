---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
---

Print a link to the run you just uploaded.

Reporting results used to end in silence: the SDK told you an upload
succeeded but not where it landed, so seeing the run meant leaving the
terminal, finding the right project, then the right suite. Every successful
upload now prints one line —
`[mcpjam/sdk] View run: <baseUrl>/evals/suite/<suiteId>/runs/<runId>?project=<projectId>`
— and `mcpjam eval run` / `mcpjam eval status` append the same link as a
`View:` line.

The route is the unflagged `/evals/…` one, not `/ci-evals/…`, whose redirect
drops the run path for readers without the flag. `?project=` carries the id
the backend now echoes on ingest responses (`ReportEvalResultsOutput.projectId`,
additive and optional, so an older deployment still parses), falling back to
an explicitly configured project and omitting the param for the zero-config
`"default"` sentinel — which is not an id, and would deep-link to nothing.

Printed once per run, from every upload shape: one-shot, chunked
start/finalize, the streaming `EvalRunReporter`, and the idempotent-reuse
short-circuit that a CI retry takes. Nothing prints when there is no run to
link to — a failed upload, or a non-strict reporter falling back to
locally-computed counts.

CLI `--format json` output is unchanged byte for byte: the link is written
separately and only in human format, so scripts parsing that stream are
unaffected.
