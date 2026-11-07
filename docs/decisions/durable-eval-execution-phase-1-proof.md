# Durable eval execution: reconstructed proof and mixed-recovery experiment

Date: 2026-10-17 (runs at 08:32Z and 08:35Z). This report backs the [phase 1 gate record](durable-eval-execution-phase-1.md). The harness, fixture and result files it names were scratch and are not committed (1,686 lines of harness and fixture); the fixture is unauthenticated and synthetic.

## Versions

| Item                           | Value                                                                                                                                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend helper source          | `a1c67a3dc4753b173109a7917d89c8d637bc8950`; the 10 files in the import closure of `convex/lib/leasedSteps.ts` + `convex/lib/evalVerdictPolicy.ts` extracted with `git archive` into `repo/` and blob-verified identical                                       |
| Convex npm package             | 1.43.0 (backend checkout's `node_modules`)                                                                                                                                                                                                                    |
| Local backend                  | release `precompiled-2026-10-06-a3538c6`, `convex-local-backend-x86_64-unknown-linux-gnu.zip` sha256 `eba2eeab62632e0c153e83f9f1c5ada9e98834e2db3386e32f825a3a97f8c093`, executable sha256 `0acde215cd6b3f5870c2ee728b6b1879ab87db722f2d2ed5bac7723769267ea7` |
| Node / OS                      | v22.22.0 / Linux 6.18.44-fc-v139 x64                                                                                                                                                                                                                          |
| Lease / deadline / generations | 1,200 ms / 60 s default / 3 default; protocol `poc-v1`; ≤20 trials                                                                                                                                                                                            |

This is a new run on a different platform from the historical 14/14 (macOS, recorded 2026-10-17T07:03:51Z); it does not relabel that result.

## Entry command

```
cd proof/harness && node run-proof.mjs
# env: POC_CONVEX_BINARY, POC_PORT (default 37210), POC_ONLY=1,15, POC_FIXTURE, POC_LABEL
```

The harness starts a fresh loopback backend (`--interface 127.0.0.1`, SQLite + local storage, ephemeral instance secret and admin key), deploys the fixture with `CONVEX_SELF_HOSTED_URL`/`CONVEX_SELF_HOSTED_ADMIN_KEY` (codegen + TypeScript), runs `tsc -p convex --noEmit` (clean), forks worker processes (`ConvexHttpClient` over HTTP), injects faults (SIGKILL, IPC hold/resume, backend SIGKILL + restart on the same DB, an HTTP proxy that drops one successful commit's acknowledgement) and kills every child in `finally`.

Results, in the harness's `results/` directory: `proof-2026-10-17T08-32-02-117Z.json` and `proof-2026-10-17T08-35-20-930Z.json` (20/20 both). Negative controls: `control-*.json`.

## Scenarios

| #    | Scenario                                                              | Result |
| ---- | --------------------------------------------------------------------- | ------ |
| 1    | Two-trial run: duplicate begin, live renewal, attempted count         | PASS   |
| 2    | Three processes race                                                  | PASS   |
| 3    | Worker killed during observation 20                                   | PASS   |
| 4    | Expired holder before takeover                                        | PASS   |
| 5    | Obsolete process resumes after takeover                               | PASS   |
| 6    | Commit acknowledgement dropped                                        | PASS   |
| 7    | Usage before/after interruption                                       | PASS   |
| 8    | Cancellation vs claim (4 raced rounds + deterministic order)          | PASS   |
| 9    | Unsupported protocol                                                  | PASS   |
| 10   | Cancel after claim + 4 units                                          | PASS   |
| 11   | Unsafe interrupted work, historical whole-run park                    | PASS   |
| 12   | 700 ms deadline                                                       | PASS   |
| 13   | Recovery allowance of one generation                                  | PASS   |
| 14   | Worker + backend killed, restart same DB                              | PASS   |
| 15   | Mixed 8 completed / 2 unsafe interrupted / 10 pending, revised policy | PASS   |
| 15.1 | Same mixed case, historical policy (contrast)                         | PASS   |
| 16   | 2 unsafe + 1 safe interrupted simultaneously                          | PASS   |
| 17   | Shared-resource counterexample (+ run-wide shared prerequisite)       | PASS   |
| 18   | Cancellation before and during adoption                               | PASS   |
| 19   | Deadline before and during adoption                                   | PASS   |

## Negative controls (each weakened fixture must fail its scenario)

| Control | Change                                               | Result                                                                          |
| ------- | ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| A       | strict guard without the lease-expiry check          | #4 FAILS: expired holder renews and commits, outcome selected                   |
| B       | revised policy replays unsafe interrupted iterations | #15 FAILS: 22 attempts, 20 selected, verdict flips to `failed`, run `completed` |
| C       | parked interrupted iterations observed as `skipped`  | #15 FAILS: attempted 18, completion 18/18 (denominator shrink caught)           |

## Deviations and conservative readings

- Interrupted iterations that will not run again are observed as `timed_out` (what the production stale-worker sweep stores); interrupted-awaiting-replay as `running` (attempted, not terminal). The brief did not name these statuses.
- Unknown replay safety is modelled as unsafe: a worker must persist an intent (`markUnsafe`) before any dispatch whose replay safety is not positively known, and only an acknowledged intent may dispatch. An interrupted attempt with no persisted intent is classified interrupted-safe by that rule. This is a protocol assumption of the fixture; production still has to decide which tool calls are positively safe (annotation hints alone are not enough).
- Revised policy: once every iteration is selected or parked the run ends `parked` (`iterations_parked`), never a passed/failed lifecycle shortcut; the verdict comes from `aggregateEvalRunVerdict`.
- The strict guard checks the deadline before the lease so refusals name the cause; `holdsLease` is used only to show (scenario 4) that it accepts an expired holder.
- Scenarios 1, 7 (takeover), 8 (claims), 9, 10 and 12 drive the first owner through the harness's own HTTP client; scenario 12's 700 ms deadline is shorter than a forked worker's startup. Kill/hold/race scenarios use forked worker processes.
- Scenario 2 accepts `lease_live` or `not_running:completed` for losers (observed `lease_live` both runs). Scenario 19b's stop point is timing-dependent (observed: last attempt began before the deadline, its commit refused after it); the assertion is the refusal reason plus "every attempt began before the deadline".
- Commit receipts are readable by the committing token without a live lease (stand-in for "authorized callers").

## What this does and does not show

Shows, functionally: adoption can be separated from per-iteration replay eligibility; unsafe/unknown interrupted iterations park individually while independent pending work continues under one more generation; the configured population and attempted denominator stay honest (20 configured, 20 attempted, 18 gradeable, inconclusive under full-completion validity, no synthesized failures); shared resources, run-wide prerequisites, cancellation and deadlines stop continuation; the historical 14 assertions still hold.

Does not show: availability, throughput or recovery latency; real network partitions (the obsolete-worker test pauses renewal); real tool execution, tenant authorization, the billing ledger, grading or E2B (all fixtures or absent); that production can declare iteration independence accurately; that a database fence recalls an already-dispatched external request (it cannot; scenarios 15 and 17 only show the coordinator refusing to replay or overlap it); bounded-batch recovery at scale (the fixture uses per-run `.collect()` on ≤20 rows); and it does not answer the phase-1 question of whether the coordinator is worth building.
