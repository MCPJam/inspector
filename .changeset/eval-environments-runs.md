---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
---

Environment-scoped eval runs, with attribution.

`run_eval_suite` and `run_eval_case` take an `environment` (name or ID) naming
which of the suite's attached project environments the run executes against —
its resolved host config, closed server set, and pinned plugin versions.
`mcpjam eval run --environment <id-or-name>` and
`mcpjam eval cases run --environment <id-or-name>` expose it on the CLI.

Selection is decided from the suite's attachments, not the caller's word:

- a suite with no attached environments runs legacy (its saved server
  selection);
- a suite with exactly ONE attached environment runs against it whether or not
  the caller names it — the platform resolves it either way, so deriving legacy
  servers would connect one server set while stamping another into the run;
- a suite with several requires the argument, and the rejection names the
  candidates.

`environment` and `servers` are mutually exclusive and rejected as such before
the request is built — an environment supplies a closed server set that a
server override cannot change, so honoring both would silently drop one.

Both run results, and `get_eval_run` / `list_eval_suite_runs` / `cancel_eval_run`,
now report the environment a run actually used (`{ id, name, revision }`, `null`
for a legacy run), read from the run's immutable snapshot rather than the
suite's current attachments. That closes the audit gap: until now an API caller
could launch into an environment but never confirm which one, at which revision,
a finished run had used.

`PlatformEvalRun` and `PlatformEvalRunCreated` gain `environment`;
`PlatformEvalSuiteDetail` gains `environmentIds`; `PlatformEvalSuiteSchedule`
gains `environmentId` (the wire already carried the last two).
