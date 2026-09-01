---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
"@mcpjam/inspector": patch
---

Stage analytics becomes reachable from an agent and a shell, not just the web app

The user-value chain is described by two documents, and only one of them had ever been wrapped in an operation. `get_eval_run`'s `decisionSummary` says what one trial did and where it stopped; **stage analytics** says how much of the run was measured at all — per stage, how many trials it applied to, how many reached it, how many were measured there, how many passed and failed, and how many were excluded and why, overall and sliced marginally by intent, model and host. The routes existed. The client methods existed. No `PlatformOperation` wrapped either, so no MCP tool and no CLI command could ask, and nothing recorded that as a gap. This closes it — and records the product decision that Lane D deliberately deferred.

**Two operations, not one.** `get_eval_run_stage_analytics` reads one run. `list_eval_suite_stage_analytics` pages a suite's runs newest-first, one complete document per run. The listing is not a convenience wrapper: an agent asked "which stage has been failing this month" cannot answer through the run-scoped op without already knowing every run id, and walking a suite listing to reach one known run is unbounded work that fails outright once the run falls outside the window.

**The listing is a TREND SERIES, never an aggregate.** Nothing sums or averages documents anywhere. Both descriptions and the registry prompt notes carry the comparability contract, not just "never sum": two funnels drawn side by side *is* a comparability claim, and it holds only within a partition on `runGroupId`, `configRevision`, `caseSetFingerprint`, `stageAnalyzerVersion`, `measurementsSchemaVersion` and `materializationState: "final"`. An **absent** run group, config revision or case-set fingerprint **blocks** comparability rather than being assumed compatible — two runs that both record nothing compare equal under a naive check while sharing nothing at all. "Which stage has been failing this month" is answerable only within one partition; across partitions it reports a change in what was measured as a change in the server.

**Three absences, and none may impersonate another.** A bare 404 means the deployment does not serve the route — an explicit error, because rendering it as "never measured" would report every run on that deployment as unmeasured, which is the dark-ship failure mode the web wrapper's own comment warns about. An enveloped `NOT_FOUND` from the analytics route alone is ambiguous: the API declines to separate "no document" from "no such run" so it does not leak the existence of runs in projects the caller cannot see. So the run op **fetches the run first**: a run that cannot be retrieved fails as run-not-found, and only a run that WAS retrieved and has no document returns `analyticsState: "unmeasured"` with `analytics: null` — permanently, because there is no backfill.

**One CLI command**, `mcpjam cloud eval stage-analytics`, with `--run` XOR `--suite` (and `--cursor`/`--limit` for the listing). Both selectors refused when neither or both are given, and the paging flags refused on `--run`, where there is only one document.

Both are `readOnly` reads with no risk facet, both mint an eval-run permalink, and both are registered in every registry that partitions the operation catalog: the MCP catalog and its README table, the agent op registry with prompt notes, the in-app workspace toolset, the CLI bindings, and the docs.
