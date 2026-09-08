---
"@mcpjam/sdk": minor
---

Declare a run's launcher and CI job, and identify the file that owns a suite

`PlatformApiClientOptions` gains `launcher` and `ci`, emitted as the
`x-mcpjam-launcher` / `x-mcpjam-ci` headers on the two eval-run launch calls
and nowhere else. `source` is stamped by the server, so every CLI, Action and
MCP launch is honestly `api`; these carry the label that says which. Set at
client construction rather than per operation: the host process is what knows
its own identity, and a per-operation argument would end up on `run_eval_suite`'s
input schema where a model could write it. Headers rather than body fields
because both launch bodies are strict — a new body field is a 400 on any
deployment that predates it.

`detectCiMetadata()` projects `detectConformanceCiMetadata()` onto a run's
provider-neutral field names, so one detector decides what "we are in CI" means
and a composite CLI run and an eval run from the same job cannot disagree about
which commit they were. `detectLauncherKind(env, fallback)` mirrors the
reporter's `GITHUB_ACTIONS` probe.

The suite/case write operations accept `declaredSuiteId`. A suite authored by a
suite file or by SDK ingest is configured in a repository and the platform now
refuses edits to it from anywhere else with a 409 — passing the suite's own
declared id identifies the write as the owning file's; any other id does not.
`PlatformEvalRun` gains `launcher`, `attribution` and `ciMetadata`,
`PlatformEvalSuiteDetail` gains `managedBy`, and `PlatformEvalRun.source` is
the real union instead of `string`. `ciMetadata` closes the loop the header
opens: a launch that arrives with `x-mcpjam-ci` records a commit, and reading
it back is what makes `mcpjam cloud eval gate --baseline-sha` able to find a
CI-launched run rather than only an SDK-reported one.

`detectCiMetadata().pipelineId` is the RAW `GITHUB_RUN_ID`. The conformance
detector's `runId` keeps its `.<attempt>` suffix, because that identity is
per-attempt; a run row's pipeline id has to be the number `runUrl` points at
and the Actions API answers to.
