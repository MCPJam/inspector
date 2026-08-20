---
"@mcpjam/inspector": minor
"@mcpjam/sdk": minor
---

Add `POST /projects/{projectId}/eval-run-groups` — one atomic fan-out launch.

Running an eval suite against several attached hosts or environments meant N
separate `POST /eval-runs` calls, and nothing tied them together. Each one
charged its own concurrency slot (so a 3-target fan-out was unlaunchable under
the default cap of 2), each one could fail after its siblings had already
started spending, and the `runGroupId` that grouped their rows was minted by the
client — a claim about intent the server had no way to verify.

The new endpoint is the only surface with grouped-launch semantics. It mints the
group id, bounds the fan-out at 10 targets, requires ONE axis (all environments
or all hosts — a mix would have to answer whether a host runs inside an
environment or beside it), deduplicates targets by id, validates every target
against the suite's attachments AND runs the static harness-admission checks
before launching anything, and holds exactly one organization concurrency slot
for the whole group — released only when the last sibling finishes, through
whichever of the two paths that sibling took.

The receipt is discriminated rather than optional-field soup: `outcome` is
`started | partial | failed`, and each target entry is either
`{status: "started", runId, runStatus, …}` or `{status: "failed", error}`. A
per-target failure does not abort its siblings. Deprecated top-level mirrors of
the first started run are preserved for readers written against the single-run
receipt, and are absent when nothing started rather than inventing a run.

Send an idempotency key and the launch becomes replayable: the group id is
derived from the key and each target's run key from that, so a retry after a
crash mid-launch returns the original run ids instead of double-launching the
targets that already started.

`POST /eval-runs` gains two things: it accepts the PUBLIC match-option
vocabulary (`any|in-order|exact`, `extraToolCalls`, `arguments`) alongside the
internal one, and it echoes a caller-supplied `runGroupId` — as a display label
only. It gives N separate launches no group treatment, which is exactly why a
fan-out has to come through the new endpoint.

The OpenAPI spec also documents the single-run fields it has been accepting all
along and never described: `caseIds`, `matchOptionsOverride`, `namedHostId`,
`refreshSnapshot` (flagged as the persisted suite mutation it is), `runGroupId`,
`idempotencyKey`, and `skillsOverride`.
