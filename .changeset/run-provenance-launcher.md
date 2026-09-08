---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

Declare a run's launcher and CI job, and name a suite file's own writes

`PlatformApiClient` takes two new options, `launcher` and `ci`, and emits them
as `x-mcpjam-launcher` / `x-mcpjam-ci` on eval-run launches only. The platform
stamps `source` itself and everything over the public API is `api`, so a CLI
run, a GitHub Actions job and an MCP agent were one indistinguishable badge;
these say which, as a declared label beside the stamp rather than inside it.
Headers rather than body fields because both launch bodies reject unknown
properties, so a body field would 400 against every older deployment.

They are set on the CLIENT, not per call: the host process knows what it is,
and putting it on a run's arguments would expose it as a settable field of the
MCP `run_eval_suite` tool.

`detectConformanceCiMetadata` is now `detectCiMetadata` (the old name is an
alias — nothing to change), and `detectLauncherKind(env, fallback)` mirrors its
`GITHUB_ACTIONS` test so a conformance upload and an eval run from the same job
never disagree about where they came from.

The suite write operations (`update_eval_suite`, `set_eval_suite_environments`,
`create_eval_cases`, `update_eval_case`, `delete_eval_case`) accept an optional
`declaredSuiteId`. A suite whose configuration lives in a repository is now
read-only on the platform; naming the suite's own declared id is how the file's
own sync is allowed through. Omit it for ordinary edits.

`PlatformEvalRun` gains `launcher` and `attribution`, and
`PlatformEvalSuiteDetail` gains `managedBy: "ci" | "app"` — the answer an API
caller previously could not get until a write came back 409.
