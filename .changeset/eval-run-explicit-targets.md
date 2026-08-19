---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

Give `run_eval_suite` the full target matrix — explicitly, never guessed.

The web UI could fan an eval suite out across every attached host or
environment, apply iteration and matcher overrides, and refresh the suite's
snapshot. `run_eval_suite` took a project, a suite, servers, and one
environment. Worse, a host-attached suite run from an agent surface silently
executed under the suite's DEFAULT host config — the run happened, and the
result was attributed to a host that never ran it — and a multi-environment
suite simply errored.

Targets are now explicit. A suite with nothing attached runs its saved
selection, exactly as before. A suite with exactly ONE attached environment or
host runs against that one automatically — not a guess, the only option, and
the fix for the mis-attribution. A suite with SEVERAL fails with
TARGET_REQUIRED naming every choice, because each of the alternatives is a
different amount of the caller's money. `environment`/`environments`,
`host`/`hosts` name targets; `allAttached` runs every one of them, one paid run
each, through the single atomic batch endpoint rather than N independent
launches.

Every selector resolves AND is checked against the suite's attachments before
the first request. A fan-out issues one launch per target, so a bad target
found late is a bad target found after its siblings started spending.

Both launch operations now carry `risk: "spend"`, which every surface reads
instead of re-deriving "does this cost money" from an operation name: the MCP
catalog appends a COSTS MONEY cue to their descriptions, and the in-app agent
marks their approvals spend-severity.

Agent proposals for a fan-out are FROZEN at mint time: `allAttached` is
resolved to an explicit id list and dropped, so attaching a fourth environment
between the proposal and the click cannot widen an approved 3-run spend to 4.
The approval line says how many paid runs a click starts, and a grouped launch
links to the group rather than to one of its runs — linking the first run would
hide a sibling's failure.

New knobs on both run operations: `iterations`, `cases`, `matchOptions` (public
vocabulary), `excludeSkills`, `notes`, `minPassRate`, `idempotencyKey`, and
`refreshSnapshot` — which states up front that it PERSISTS a new host-config
snapshot on the suite, and is rejected on any multi-target launch where
last-writer-wins on a frozen snapshot is never what was meant.
