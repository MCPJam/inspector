---
"@mcpjam/sdk": minor
"@mcpjam/inspector": minor
"@mcpjam/cli": minor
---

Directory readiness reaches the MCP tools, the agent, in-app chat and the CLI

Six operations in the platform catalog, and the five registries that fan them
out. One PR because it has to be: the MCP worker's partition guard throws at
module load, so an operation that exists without a catalog entry does not fail
a test — it stops the worker from booting.

**Starts return a receipt, and every surface says so.** A run dials somebody
else's server for minutes, so the API answers `202` and the caller polls. A
model handed a receipt will report the receipt as the answer unless told
otherwise, which is what the tool descriptions and the agent's prompt notes
are for.

**The spend declaration is the worst case; the approval copy is the real one.**
`includeLlmObservations` defaults off and most runs are free, but `risk` is a
static field read by five surfaces, and one that described the cheap case
would describe the case that needs no describing. So the starts declare
`spend` — and the agent's `confirmSeverity` is a FUNCTION, so a run without
the flag still asks for approval saying it costs nothing. Cancel declares
`none`: it stops traffic to a third party and destroys no record, which is why
it is direct rather than gated, matching `cancel_wave_insights` beside it.

**The report operation returns a projection, not the document.** A stored
report can be megabytes and the chat surface caps model output at 24k
characters — a cut that lands mid-structure produces a JSON object that still
parses and is simply wrong. So the operation caps the findings itself, orders
them most-consequential-first so a truncated list keeps what matters, drops
the raw per-finding evidence a model has no use for, and reports
`totalFindings` / `returnedFindings` / `truncated` so a subset can never read
as the whole.

**The three axes are taught, not just exposed.** Prompt notes state that
`status`, `overallStatus` and `llmObservations` answer different questions:
that a `completed` run can be `not-ready`, that a `billing-blocked`
observation leaves a complete and valid grade, and that a run which FAILED
produced no grade at all and must never be reported as a verdict about the
server. Without that, every model surface reports the first field it finds.

The CLI gains the hosted half beside its local one — `readiness start`,
`status`, `list`, `cancel`, `report` — because a hosted run reaches the server
through the saved row and the authorize exchange, which is how the platform
itself reaches it. A different question from what the local command answers,
and the only one that can spend for observations or leave a record.

Also maps the six `/api/v1` readiness routes to their SDK client methods in
the coverage ratchet, which has been failing on `main` since the routes
shipped.
