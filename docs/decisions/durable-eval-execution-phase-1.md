# Durable eval execution: phase 1 gate (2026-10-17)

## Decision

**Defer.** The phase 1 decision gates five phases of the implementation brief
for [BB-315](https://app.kestral.ai/workspace/yhNILB2/task/1O2BRXDc), and none
of them is started:

- 2: an inert backend coordinator and attempt history (schema expansion,
  coordinator modules, a strict run-specific lease guard).
- 3b: a durable hosted eval adapter (a single-flight lease client, bounded
  polling, local expiry abort, short-lived execution grants).
- 4: production usage attribution and recovery accounting (attempt identity in
  every usage writer, refund eligibility recorded at interruption).
- 5: staging qualification and a limited canary.
- 6: launch-path cutover: UI, API and schedules through one admission path,
  then GitHub checks.

Phase 7 (swarms as a separately proven adapter) comes only after eval
qualification, so it waits with them.

The gate asks whether interrupted eval execution is still frequent and costly
enough, once the cheaper fixes below are deployed, to justify a coordinator.
Nothing in hand answers that. The interruption measurement could not be
collected from this environment, and the signal that counts deploy losses
starts reporting only once the shutdown changes below ship. Missing data is
not a go decision: the gate stays closed until the measurement below has run
for its window and the gate's owner reads it against the threshold recorded
before it started.

Phase 3a (a worker role, so claimed jobs can run in their own deployment,
MCPJam/inspector#6684) does not depend on this gate and proceeds separately.
HTTP-started UI and API eval runs stay on the web executor, protected only by
the drain, until a delivery contract exists for handing them to another
process (see Credentials).

## What phase 1 changed

All of these are open pull requests, none merged, as of 2026-10-19.

| Area              | Pull requests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shutdown          | MCPJam/inspector#6666 (the container's main process is the launcher, so SIGTERM reaches the server at all), #6667 (one shutdown timeline), #6668 and #6669 (claim loops behind one handle, stopped together), #6670 (drain coordinator), #6671 (bounded drain, `server.shutdown.drain`), #6674 (v1 runs detach through the shared helper), #6675 (launch admission while draining), #6677 (detached and quick runs drain), #6678 (swarm runs and doorbells drain), #6683 (the drain waits for claims answered after the stop)                                                                                                                                                                                                                                                                                                                   |
| Independent fixes | MCPJam/mcpjam-backend#2251 (`timed_out` completes a run group), MCPJam/mcpjam-backend#2252 (eval boxes reaped by owner liveness), MCPJam/mcpjam-backend#2254 (a quick-run watchdog), MCPJam/mcpjam-backend#2261 (the watchdog's scan reads past attempts that are not due yet, one cursor page at a time), MCPJam/mcpjam-backend#2263 (the existing quick-run crons registered from their own module), MCPJam/mcpjam-backend#2256 (swarm budgets frozen at launch), MCPJam/mcpjam-backend#2257 (authored swarm budgets accepted and range-checked); MCPJam/inspector#6647 (no false swarm completion on another replica), #6648 to #6652 (one SDK definition of run and iteration lifecycle), #6655 (frozen swarm budgets used), #6656 to #6660 (eval turns on the shared entry point, with a guard), #6662 (run-group analysis on `timed_out`) |
| Contract          | MCPJam/mcpjam-backend#2262 (what a run reports today when its worker is lost)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

None of these changes failure or inconclusive semantics. The contract test in
MCPJam/mcpjam-backend#2262 pins them so a later change has to be deliberate.

## The measurement that decides the gate

Run for four weeks once every pull request in the Shutdown row above is
deployed with a drain configured (`MCPJAM_SHUTDOWN_DRAIN_MS` with
`RAILWAY_DEPLOYMENT_DRAINING_SECONDS`). Until MCPJam/inspector#6677 and #6678
are live, nothing tracks eval runs, quick runs, swarm runs or doorbell passes,
so their remainders would read zero. Read it per week: item 1 per kind of
work, the others by source.

1. **Work a deploy still cut.** One `server.shutdown.drain` row per replica
   shutdown in the inspector's clean dataset (`AXIOM_CLEAN_DATASET`):
   `drainMs`, `drainClamped`, `drained`, `waitedMs`, `inFlightAtStart` and
   `remainingClaimedJobs`, `remainingEvalRuns`, `remainingSwarmRuns`,
   `remainingDoorbells`, `remainingQuickRuns`. A non-zero remainder is work
   still running as the teardown starts. The row has no source, and
   `inFlightAtStart` is one total across kinds, so this item is read per kind,
   from the remainders only: `eval_run` covers every HTTP launch, and every
   claimed job counts as `claimed_job` whatever its loop. Split by
   `drainClamped`, because a drain that Railway's draining window clamped
   explains a remainder.
2. **Runs and iterations the backend gave up on.** The backend emits
   `eval_execution_stopped` with `reason`, `phase`, `source`, `runId` and
   `iterationId`: one event per stopped iteration and attempt, and a run-level
   event only when no iteration of that attempt reported
   (`convex/lib/evalExecutionFailure.ts`). Counting events therefore counts
   neither runs nor iterations, so the query counts distinct run ids, and
   distinct iteration ids for quick runs, whose events carry no `runId`. The
   same parse the existing PAGE monitor uses
   (`ops/axiom-monitors/monitors/eval-execution-stopped.json` in the backend)
   gives the weekly counts. `<start>` is the midnight UTC the window opens on,
   fixed before reading, and the weeks are counted from it, so the first and
   last are not split wherever rolling bins happen to fall.

   ```
   ['mcpjam-backend-clean-v1']
   | where _sysTime >= datetime(<start>) and _sysTime < datetime(<start>) + 28d
   | extend msg = tostring(['data.message'])
   | where msg contains '[mcpjam_operational_event]' and msg contains '"event":"eval_execution_stopped"'
   | extend payload = parse_json(extract(@'\[mcpjam_operational_event\] (.*)', 1, msg))
   | extend Reason = tostring(payload.reason), Source = tostring(payload.source),
            Run = tostring(payload.runId), Iteration = tostring(payload.iterationId),
            Week = bin(_sysTime - datetime(<start>), 7d)
   | summarize StoppedRuns = dcountif(Run, isnotempty(Run)),
               StoppedQuickRunIterations = dcountif(Iteration, isempty(Run))
       by Week, Reason, Source
   ```

   `stale_worker` is a lost worker (a deploy, a crash, an OOM). The other
   reasons are failures a coordinator would not prevent; they belong in the
   denominator of "what stopped", not in the case for building one. This query
   has not been run; it needs the backend's Axiom access.

3. **Denominators.** Accepted runs per source per week: `auditEvents` rows
   with action `eval.run.launched`, indexed by action and timestamp, with the
   source in `metadata.source`. `testSuiteRun.source` gives the same split, but
   no index serves it by creation time. Leave out `sdk`: those runs push
   results from the caller's own process and never heartbeat (`sdk` is not in
   `EVAL_RUN_HEARTBEAT_SOURCES`), so none can stop as `stale_worker`.
   Quick-run iterations created: `testIteration` rows with `trigger: 'quick'`,
   which includes compare batches; quick runs have no run row, and
   `auditEvents` marks each start as `eval.run.quick_started`. No saved query
   reads any of these yet.
4. **Cost.** Credits refunded for stale-worker runs: `creditTransactions` rows
   keyed `refund:fee:eval_step:eval_step:run:<runId>` whose run ended with
   `stopReason: 'stale_worker'`. The ledger row has no reason field, so join on
   the run id; shadow-mode charges are in `rateCardShadowCharges` instead.
   Quick runs whose inspector died are refunded only once
   MCPJam/mcpjam-backend#2254's watchdog is live, under
   `refund:fee:eval_step:eval_step:quick:<firstIterationId>`; main refunds a
   quick batch only when its last iteration ends. From `auditEvents`, which
   covers every source: how often the same suite is launched again within the
   hour after a `stale_worker` stop (`eval.run.launched` with the same
   `metadata.suiteId`, split by `metadata.source` because a schedule
   relaunches on its own interval), and the same case
   (`eval.run.quick_started` with the same `metadata.testCaseId`). The product
   analytics events `eval_suite_run_started_server` and
   `eval_test_case_run_started` see UI launches only.
5. **Claimed-job recovery.** Neither inspector loop logs picking up a job
   whose lease expired, so this is read from the rows the backend's sweeps
   leave:
   - Scheduled runs: `scheduledRunTrigger` rows failed with
     `failureReason: 'lease_expired'`, which carry no `runId`. The worker
     reports `complete` only after the run returns and nothing heartbeats the
     trigger, so the 35 min lease covers the whole run, beside the run's own
     heartbeat. A worker lost mid-run leaves both a `stale_worker` stop,
     counted in item 2, and a `lease_expired` trigger; a healthy run that ends
     more than 35 min after its claim leaves a `lease_expired` trigger too.
     Count only `lease_expired` triggers with no `testSuiteRun` whose
     `idempotencyKey` is the trigger id: the worker launches with that key, so
     those lost the claim before the run existed. An expired trigger is not
     retried.
   - GitHub checks: trigger rows failed with
     `failureReason: 'heartbeat_stale'` after 5 min without a heartbeat, ended
     as `infra_error` and not retried. The `github_checks_recovery_sweep` event
     counts them per sweep (`expiredClaims`).
   - Benchmark jobs: `benchmarkJobs` with `failureCode: 'WORKER_ABANDONED'`
     after the 90 s lease, requeued under a new `leaseGeneration`.
     `benchmark_job_failed` fires only once a job's attempts run out.

   A job a deploy cut is noticed only once its lease or heartbeat window runs
   out, so each recovery costs up to that window before the job is retried or
   ended.

The brief sets no threshold, and this record does not invent one. BB-315's
owner states it, in the units above (for example stale-worker runs per
thousand accepted runs, and credits refunded per week), in a follow-up pull
request to this file that names them and is merged before `<start>`. A
threshold stated after the window opens does not count.

## Evidence gathered in phase 1

Kept apart from the historical proof result, which is not relabelled.

**Historical:** the proof in the implementation brief on BB-315 recorded 14 of
14 scenarios passing on macOS (2026-10-17T07:03:51Z). Its harness is not in
this repository.

**New, from production code:** MCPJam/mcpjam-backend#2262 seeds a run of 20
iterations (8 completed, 2 in flight, 10 not started) and runs the real
stale-run watchdog. The run ends `timed_out` with `stopReason: stale_worker`
and no verdict; all 12 unfinished iterations end `timed_out`, the never-started
ones included, and none is `failed`. Decided from that evidence, the v2 policy
says `inconclusive` (`completionRateBelowMinimum`), with all 20 counted as
attempted. A revised policy that leaves never-started work out of the attempted
denominator would change that number, and should only do so on purpose.

**New, reconstructed proof ([report](durable-eval-execution-phase-1-proof.md)):**
a fresh run on Linux (Node 22.22.0, Convex npm 1.43.0, local backend
`precompiled-2026-10-06-a3538c6`, backend helper source `a1c67a3`) passed 20 of
20 scenarios twice: the historical 14 (scenarios 1 to 14) and six more,
numbered as in the run's report. The report is committed beside this record;
the harness and fixture it ran are not.

- 15: the mixed 8 completed / 2 unsafe interrupted / 10 pending case under a
  revised policy: 20 configured, 20 attempted, 18 gradeable, `inconclusive`
  under full-completion validity, no synthesized failures;
- 15.1: the same case under the historical whole-run park, for contrast;
- 16: two unsafe and one safe iteration interrupted at once;
- 17: a shared-resource counterexample, with a run-wide shared prerequisite;
- 18: cancellation, before and during adoption;
- 19: a deadline, before and during adoption.

Three weakened fixtures each failed their scenario as they should: a guard
without the lease-expiry check, a revised policy that replays unsafe work, and
a park recorded as `skipped`. It shows that adoption can be separated from
per-iteration replay eligibility, and that the denominators stay honest. It
does not show availability, latency, real tool execution, billing, grading,
E2B, or that production can declare iteration independence accurately; and
it does not answer this gate.

## Inventory, with dispositions

### Launch paths

| Source                               | Entry and executor                                                                               | Liveness today                                                           | Disposition                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------- |
| UI suite run, replay                 | `POST /api/web/evals/run`, `/replay-run`; detached on the web process                            | 15 s heartbeat, stale after 60 s, then `stale_worker` timeout and refund | Drained and admission-checked; stays on the web executor   |
| API, MCP, agents, CLI, GitHub Action | v1 `eval-runs`, `eval-run-groups`, `rerun`, description experiments; detached on the web process | as UI                                                                    | as UI                                                      |
| Quick run                            | `/run-test-case` (inline), `/stream-test-case` (SSE); no run row                                 | none until the quick-run watchdog                                        | Watchdog times out and refunds; drained                    |
| Local mode                           | `/api/mcp/evals/run` on the user's machine                                                       | as UI                                                                    | Out of scope for the hosted drain                          |
| Scheduled                            | backend cron, claimed by the scheduled-evals loop                                                | 35 min lease on the trigger for the whole run; the run heartbeats as UI  | Stops claiming at shutdown; drained; worker-role candidate |
| GitHub check                         | webhook, claimed by the GitHub-checks loop                                                       | 60 s heartbeat, stale after 5 min                                        | as scheduled                                               |
| Benchmark                            | claimed by the bench loop                                                                        | 20 s heartbeat, 90 s lease with `leaseGeneration`                        | as scheduled                                               |
| Swarm run                            | `launchJourneyRun`; detached on the web process                                                  | heartbeat; aborted at teardown                                           | Drained and admission-checked                              |
| Doorbells (4)                        | backend POSTs to `/api/internal/*`                                                               | backend sweeps re-deliver                                                | Refused while draining (503); passes drained               |
| SDK                                  | the caller's own process, results pushed                                                         | 24 h idle and 7 d expiry                                                 | Unchanged: not ours to host                                |

### Writers that a takeover would need fenced

None of these matters while only one executor can exist for a run. Each one
does matter the moment a second executor can take a run over, so fencing them
belongs to phase 2's strict run-specific guard, not to phase 1.

- `runtimeSummary.attemptId` records attempts but fences nothing: takeover passes `previousAttemptId`, and the lifecycle, result and trace writers ignore it.
- `internalUpdateTestIteration` can overwrite a `completed` or `failed` iteration (it refuses only `cancelled` and `timed_out`).
- `updateTestSuiteRun` has no attempt check, and the heartbeat checks only status.
- `completeScheduledRun` checks that the run is `claimed`, not who claimed it.
- The benchmark runner bearer is scoped to the run, project and server, not to `leaseGeneration`; the execution grant already is, and heartbeats and writes check it.
- A deduplicated replay of a run still running executes it again: `shouldSkipExecution` skips a replay only when its run is past execution or its server is unreachable.

### Credentials, against how long a run can last

| Credential                               | Lifetime                                                                                          | Disposition                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Hosted UI bearer                         | captured at the request, never renewed (`getConvexBearerThunkForRequest` in `v1-convex-token.ts`) | Blocks handing an HTTP-started eval run to another process |
| Delegated JWT                            | 2 h, 4 h at most; an eval launch captures one at the request                                      | as above                                                   |
| MCP OAuth tokens                         | captured; refreshed on a 401 with the captured bearer                                             | as above                                                   |
| Org provider keys                        | resolved once at prepare                                                                          | Re-resolvable by the backend                               |
| Platform models                          | admitted per attempt                                                                              | Fits a resumed attempt                                     |
| Harness broker lease                     | per turn, 30 min                                                                                  | Fits                                                       |
| Harness MCP proxy token                  | 1 h, bound to run and iteration                                                                   | Needs reissue on resume                                    |
| GitHub installation token                | 1 h, fetched fresh for each use, never cached                                                     | Fits                                                       |
| Benchmark runner bearer, grant           | bearer 50 min, minted at claim and never reissued; grant 1 h, reissued by the heartbeat           | Bearer needs reissue for long jobs                         |
| `INSPECTOR_SERVICE_TOKEN`, `E2B_API_KEY` | process environment                                                                               | Fit any process                                            |

The first three are why HTTP-started eval runs stay on the web executor. Any
process that resumes or receives such a run needs renewable credentials scoped
to the run, minted by the backend; capturing the caller's credentials at
launch cannot provide that. Swarm runs, HTTP-started too, already re-resolve
theirs: `getBackgroundRunBearerForRequest` gives a hosted session or a
delegated caller, such as an API key, a delegated JWT that is minted again as
it nears expiry.
