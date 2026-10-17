# Durable eval execution: phase 1 gate (2026-10-17)

## Decision

**Defer.** Phases 2, 3b, 4, 5 and 6 (a durable coordinator for eval
execution, fenced writers, revised recovery semantics and moving HTTP-started
runs off the web process) are not started.

The gate asks whether interrupted eval execution is still frequent and costly
enough, once the cheaper fixes below are deployed, to justify a coordinator.
Nothing in hand answers that. The interruption measurement could not be
collected from this environment, and the signal that counts deploy losses
starts reporting only once the shutdown changes below ship. Missing data is
not a go decision: the gate stays closed until the measurement below has run
for its window and someone with ownership of evals reads it against a
threshold stated beforehand.

Phase 3a (a worker role, so claimed jobs can run in their own deployment) does
not depend on this gate and proceeds separately. HTTP-started UI and API eval
runs stay on the web executor, protected only by the drain, until a delivery
contract exists for handing them to another process (see Credentials).

## What phase 1 changed

| Area              | Pull requests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shutdown          | MCPJam/inspector#6666 (the container's main process is the launcher, so SIGTERM reaches the server at all), #6667 (one shutdown timeline), #6668 and #6669 (claim loops behind one handle, stopped together), #6670 (drain coordinator), #6671 (bounded drain, `server.shutdown.drain`), #6674 (v1 runs detach through the shared helper), #6675 (launch admission while draining), #6677 (detached and quick runs drain), #6678 (swarm runs and doorbells drain)                                                                                                                                                |
| Independent fixes | MCPJam/mcpjam-backend#2251 (`timed_out` completes a run group), MCPJam/mcpjam-backend#2252 (eval boxes reaped by owner liveness), MCPJam/mcpjam-backend#2254 and MCPJam/mcpjam-backend#2261 (quick-run watchdog, paged), MCPJam/mcpjam-backend#2256 and MCPJam/mcpjam-backend#2257 (swarm budgets frozen at launch); MCPJam/inspector#6647 (no false swarm completion on another replica), #6648 to #6652 (one SDK definition of run and iteration lifecycle), #6655 (frozen swarm budgets used), #6656 to #6660 (eval turns on the shared entry point, with a guard), #6662 (run-group analysis on `timed_out`) |
| Contract          | MCPJam/mcpjam-backend#2262 (what a run reports today when its worker is lost)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

None of these changes failure or inconclusive semantics. The contract test in
MCPJam/mcpjam-backend#2262 pins them so a later change has to be deliberate.

## The measurement that decides the gate

Run for four weeks after MCPJam/inspector#6666 and #6671 are deployed with a
drain configured (`MCPJAM_SHUTDOWN_DRAIN_MS` with
`RAILWAY_DEPLOYMENT_DRAINING_SECONDS`). Read it per week, by source.

1. **Work a deploy still cut.** One `server.shutdown.drain` row per replica
   shutdown in the inspector's clean dataset (`AXIOM_CLEAN_DATASET`):
   `inFlightAtStart`, `drained`, `waitedMs` and `remainingClaimedJobs`,
   `remainingEvalRuns`, `remainingSwarmRuns`, `remainingDoorbells`,
   `remainingQuickRuns`. A non-zero remainder is work still running as the
   teardown starts.
2. **Runs and iterations the backend gave up on.** The backend already emits
   `eval_execution_stopped` with `reason`, `phase` and `source`, once per
   accepted run attempt and per iteration. The same parse the existing PAGE
   monitor uses (`ops/axiom-monitors/monitors/eval-execution-stopped.json` in
   the backend) gives the weekly counts:

   ```
   ['mcpjam-backend-clean-v1']
   | where _sysTime >= ago(28d)
   | extend msg = tostring(['data.message'])
   | where msg contains '[mcpjam_operational_event]' and msg contains '"event":"eval_execution_stopped"'
   | extend payload = parse_json(extract(@'\[mcpjam_operational_event\] (.*)', 1, msg))
   | extend Reason = tostring(payload.reason), Source = tostring(payload.source),
            Level = iff(isempty(tostring(payload.iterationId)), 'run', 'iteration')
   | summarize Count = count() by bin(_sysTime, 7d), Reason, Source, Level
   ```

   `stale_worker` is a lost worker (a deploy, a crash, an OOM). The other
   reasons are failures a coordinator would not prevent; they belong in the
   denominator of "what stopped", not in the case for building one. This query
   has not been run; it needs the backend's Axiom access.

3. **Denominators.** Accepted runs per source per week, from `testSuiteRun`
   rows by `source` and creation time (no event marks a run's start), and the
   quick-run iterations created (`testIteration` with no `suiteRunId`).
4. **Cost.** Credits refunded for stale-worker runs and quick runs (the refund
   ledger rows for `eval_step:*` charge keys settled by the stale sweeps) and,
   from product analytics, how often a user relaunches the same suite or case
   within the hour after a `stale_worker` stop.
5. **Claimed-job recovery.** Stale-lease recoveries for scheduled runs (a 35 min
   fixed lease), GitHub checks (5 min stale cutoff) and benchmark jobs (90 s
   lease), which say how much a deploy costs the claim loops in latency.

The brief sets no threshold, and this record does not invent one. State it
before reading the data, in the units above (for example stale-worker stops
per thousand accepted runs, and credits refunded per week), so the data
decides rather than motivates.

## Evidence gathered in phase 1

Kept apart from the historical proof result, which is not relabelled.

**Historical:** the earlier proof recorded 14 of 14 scenarios passing on macOS
(2026-10-17T07:03:51Z).

**New, from production code:** MCPJam/mcpjam-backend#2262 seeds a run of 20
iterations (8 completed, 2 in flight, 10 not started) and runs the real
stale-run watchdog. The run ends `timed_out` with `stopReason: stale_worker`
and no verdict; all 12 unfinished iterations end `timed_out`, the never-started
ones included, and none is `failed`. Decided from that evidence, the v2 policy
says `inconclusive` (`completionRateBelowMinimum`), with all 20 counted as
attempted. A revised policy that leaves never-started work out of the attempted
denominator would change that number, and should only do so on purpose.

**New, reconstructed proof (scratch, not committed):** a fresh run on Linux
(Node 22.22.0, Convex npm 1.43.0, local backend `precompiled-2026-10-06-a3538c6`,
backend helper source `a1c67a3`) passed 20 of 20 scenarios twice. That covers
the historical 14, plus:

- the mixed 8 completed / 2 unsafe interrupted / 10 pending case under a
  revised policy: 20 configured, 20 attempted, 18 gradeable, `inconclusive`
  under full-completion validity, no synthesized failures;
- the same case under the historical whole-run park, for contrast;
- simultaneous interruptions;
- a shared-resource counterexample;
- cancellation and deadline, before and during adoption.

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
| Scheduled                            | backend cron, claimed by the scheduled-evals loop                                                | 35 min fixed lease, no heartbeat                                         | Stops claiming at shutdown; drained; worker-role candidate |
| GitHub check                         | webhook, claimed by the GitHub-checks loop                                                       | 60 s heartbeat, stale after 5 min                                        | as scheduled                                               |
| Benchmark                            | claimed by the bench loop                                                                        | 20 s heartbeat, 90 s lease with `leaseGeneration`                        | as scheduled                                               |
| Swarm run                            | `launchJourneyRun`; detached on the web process                                                  | heartbeat; aborted at teardown                                           | Drained and admission-checked                              |
| Doorbells (4)                        | backend POSTs to `/api/internal/*`                                                               | backend sweeps re-deliver                                                | Refused while draining (503); passes drained               |
| SDK                                  | the caller's own process, results pushed                                                         | 24 h idle and 7 d expiry                                                 | Unchanged: not ours to host                                |

### Writers that a takeover would need fenced

None of these matters while only one executor can exist for a run. Each one
does matter the moment a second executor can take a run over, so fencing them
is a precondition of phase 2, not a phase 1 change.

- `runtimeSummary.attemptId` records attempts but fences nothing: takeover passes `previousAttemptId`, and the lifecycle, result and trace writers ignore it.
- `internalUpdateTestIteration` can overwrite a `completed` or `failed` iteration (it refuses only `cancelled` and `timed_out`).
- `updateTestSuiteRun` has no attempt check, and the heartbeat checks only status.
- `completeScheduledRun` checks that the run is `claimed`, not who claimed it.
- Benchmark tokens are scoped to project and server, not to `leaseGeneration`.
- A deduplicated replay of a run still running executes it again (`shouldSkipExecution` skips only finished runs).

### Credentials, against how long a run can last

| Credential                               | Lifetime                                                      | Disposition                                           |
| ---------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------- |
| Hosted UI bearer                         | captured at the request, never renewed (`v1-convex-token.ts`) | Blocks handing an HTTP-started run to another process |
| Delegated JWT                            | 2 h, 4 h at most, captured at the request                     | as above                                              |
| MCP OAuth tokens                         | captured; refreshed on a 401 with the captured bearer         | as above                                              |
| Org provider keys                        | resolved once at prepare                                      | Re-resolvable by the backend                          |
| Platform models                          | admitted per attempt                                          | Fits a resumed attempt                                |
| Harness broker lease                     | per turn, 30 min                                              | Fits                                                  |
| Harness MCP proxy token                  | 1 h, bound to run and iteration                               | Needs reissue on resume                               |
| GitHub installation token                | 45 min                                                        | Already reissued by the job                           |
| Benchmark runner bearer, grant           | bearer 50 min never reissued; grant 1 h reissued on heartbeat | Bearer needs reissue for long jobs                    |
| `INSPECTOR_SERVICE_TOKEN`, `E2B_API_KEY` | process environment                                           | Fit any process                                       |

The first three are why HTTP-started runs stay on the web executor. Any
process that resumes or receives such a run needs renewable credentials scoped
to the run, minted by the backend; capturing the caller's credentials at
launch cannot provide that.
