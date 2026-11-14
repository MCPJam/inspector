# Design note: code-first evals × project environments

Status: **design only, nothing implemented.** Written as the deliverable of the
SDK/CLI/MCP environments work, which made the *hosted* eval product fully
environment-aware and left this gap visible.

## The gap

Two eval surfaces ship in this repo, and only one of them knows what an
environment is.

**Hosted evals** (suites, cases, runs, schedules — `testSuite` rows in Convex,
driven by the web UI, the `/v1/eval-*` routes, `@mcpjam/sdk/platform`, and the
CLI's `mcpjam cloud eval …`) are now environment-aware end to end. A suite carries
`environmentIds`; a run resolves exactly one of them into a closed execution
context — host config, server set, pinned plugin versions, sandbox image pin —
and persists that resolution as an immutable `configSnapshot.environmentRef`
`{ environmentId, name, revision }`. Every launch is pinned to the revision it
resolved, so an edit between resolve and start is a 409, not a silently
different run.

**Code-first evals** (`EvalSuite` / `EvalTest` in `sdk/src/`, run from the
user's own process against a `HostExecutor` they constructed) have no
environment concept at all. `EvalSuiteConfig` is `{ name?, mcpjam? }`; the
servers, model, and host config come from whatever the caller wired up by hand
before calling `suite.run(executor, …)`. Results can be *reported* to the
platform (`MCPJamReportingConfig` → `report-eval-results.ts`), but the
configuration they ran under is the caller's private business.

So today a team can define an environment once, run their hosted suites against
it, and then have their code-first suites drift away from it silently — the
exact failure environments exist to prevent.

## What is already possible

The client half is done. `PlatformApiClient.resolveEnvironment` /
`resolveEnvironmentOperation` hit
`GET /v1/projects/{p}/environments/{e}/resolve` and return
`PlatformEnvironmentResolved`: the environment ref with its revision, the
resolved host config, the closed server set (including servers contributed by
pinned plugin versions), and the resolved plugin versions. A code-first suite
could call that and build its `HostExecutor` from the answer, today, with no
backend work.

That is the easy 80%. The hard part is what follows.

## The real question: what does an environment *mean* locally?

An environment is not a bag of settings. It is a claim about reproducibility:
"a run that resolved revision N executed against exactly this." Three of its
parts survive the trip to a local process; one does not.

**Servers — travels.** The closed server set is a list of project servers with
URLs. A local runner can connect exactly those. Caveat: stdio servers in the
set are local-only by nature, and hosted runs never execute them — so a local
run of the "same" environment can legitimately connect *more* than a hosted one
did. That difference has to be reported, not smoothed over.

**Host config — travels, with a caveat.** Model, system prompt, temperature,
tool-approval policy, capability overrides. A local `HostExecutor` can honour
all of it. But the caller supplies their own provider keys, so "same model id"
does not guarantee the same routing, and there is no equivalent of the hosted
credit/quota path.

**Pinned plugin versions — travels.** Each pin carries a `bundleHash`. A local
runner can fetch and verify them, and a hash mismatch is a hard error rather
than a warning — this is the one part of the bundle with an exact identity
check already built in.

**The sandbox image pin — does NOT travel, and this is the crux.** An
environment can pin a Computer sandbox image (`computerEnvironmentId`): an
immutable E2B image that hosted runs boot. A local process is not that image.
It is the developer's laptop, with their Node version, their filesystem, their
network. There is no honest way to say a local run "used" the pinned image.

## Three options for the image pin

1. **Refuse.** A code-first run against an environment that pins an image is an
   error: "this environment pins a sandbox image; run it hosted." Honest, and
   it keeps `environmentRef` meaning exactly one thing everywhere. Cost: the
   pin is common on exactly the environments people most want to reproduce
   locally, so this refuses the main use case.

2. **Run anyway, and never claim the pin.** Resolve the environment, use the
   servers/host config/plugins, ignore the image, and mark the result as
   *derived from* rather than *executed in* that environment. Concretely: the
   reported result carries the environment ref plus an explicit
   `environmentFidelity: "partial"` and the list of parts that did not apply.
   This is the option that respects what a snapshot is for — a partial match
   recorded as partial is useful; a partial match recorded as exact poisons
   every comparison built on top of it.

3. **Boot the image locally.** Give the SDK a real E2B path so the local run
   executes in the pinned image. This is the only option that makes the claim
   true, and it is a substantially larger piece of work (sandbox lifecycle,
   credentials, cost attribution, cold-start latency in a test loop) that
   belongs on its own roadmap, not smuggled in here.

**Recommendation: option 2, with option 1 as an opt-in strictness flag.**
Something like `new EvalSuite({ environment: { ref, require: "exact" } })`,
defaulting to `"best-effort"`. Option 3 stays a separate proposal.

## The reporting contract

Whatever is chosen, one rule should not bend: **a code-first result must never
be indistinguishable from a hosted run's `configSnapshot.environmentRef`.**
Hosted runs earn that field by resolving and re-checking the revision inside
the run-start mutation, with drift detection on both the revision and what the
revision points at. A local runner has neither guarantee — nothing stops the
environment from being edited mid-run, and nothing verifies the executor
actually honoured what it resolved.

So the reported shape should be a sibling, not the same field: the ref, the
revision it resolved, a fidelity verdict, and the specific parts that did not
apply. Then a dashboard that compares "hosted vs local under environment X" can
say which comparisons are apples-to-apples, and which are not.

## Non-goals

- Making `EvalSuite` fetch anything by default. Code-first evals run offline
  today; environment resolution must stay opt-in and explicit.
- Any change to the hosted eval product. That surface is complete.
- Booting sandbox images locally (option 3 above).

## Suggested next step

Prototype the resolve→executor path against a *non-image* environment first.
That exercises the servers/host-config/plugins translation and the reporting
shape with none of the sandbox question in the way, and it will surface whether
the host-config translation is as clean as it looks from
`PlatformEnvironmentResolved`. Only then decide on the image pin, with real
code to argue about instead of a paragraph.
