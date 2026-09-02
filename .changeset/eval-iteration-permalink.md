---
"@mcpjam/sdk": patch
---

`eval_iteration` is a platform permalink resource type

An eval iteration is now addressable through the same registry as every other
MCPJam resource: `buildAppPermalink({ type: "eval_iteration", … })` mints
`/evals/suite/<suiteId>/runs/<runId>?iteration=<iterationId>&project=<projectId>`,
labelled **View iteration**, and `isPlatformResourceType("eval_iteration")` is
true. An iteration has no page of its own — the run detail reads `?iteration=`
off its query string — so the route is the run's path with an id selector.

That route needs two ancestors (the run, and the run's suite), which the
single-`parent` ref could not express. `PlatformResourceRef.parent` is now a
`PlatformResourceParentRef` that may carry its own `parent`, and route
segments gained `":grandparent"` beside `":parent"`. The builder walks the
chain against the table — the iteration entry says only "under `eval_run`";
that a run lives under a suite is still stated once, on `eval_run` — and
refuses a chain that is short or wrong at any level. Existing single-parent
refs are unchanged in shape and mint identical URLs.

`evalIterationRef(iterationId, runId, suiteId, projectId?)` is exported from
`@mcpjam/sdk/platform` operations for the follow-up that wires a caller:
`get_eval_iteration_trace` still declares no permalink, because its response
names no suite to reach the run through.
