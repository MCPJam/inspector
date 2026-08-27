/**
 * bench-worker.ts — polling executor for hosted Connector Bench runs.
 *
 * Same pull/claim architecture as `scheduled-evals-worker.ts` and
 * `github-checks-worker.ts`: the backend never calls the Inspector. A hosted
 * start lands a `benchmarkJobs` row in Convex; this loop claims one at a time
 * over the service-token-gated `/internal/v1/bench/*` routes and drives the
 * EXISTING `prepareEvalRun()` → `execute()` pipeline once per matrix cell.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT MAKES THIS ONE DIFFERENT: THE WORK IS PAID FOR, AND IT IS INTRUSIVE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A benchmark run spends someone's credits and dials a third party's server,
 * so two properties matter more here than in the sibling workers:
 *
 *   1. TWO WORKERS MUST NEVER DRIVE ONE JOB. The lease is refreshed every 20s
 *      and `assertLeaseHeld()` runs between every step; a worker that keeps
 *      launching children after losing its lease charges the run twice for the
 *      same evidence. A `leaseOk: false` heartbeat — and a 409 `lease_lost`
 *      from any write route — is DEFINITIVE, not transient: we stop, and we
 *      write nothing further, because the job already belongs to somebody else.
 *
 *   2. A REDELIVERED CLAIM MUST NOT RE-RUN ANYTHING. Every child's
 *      idempotency key is `benchmarkRunId + evidenceKey`, both pure functions
 *      of the pinned definition, so a resumed job joins the children it already
 *      started instead of paying for a second intrusive run against someone
 *      else's server. Rostered evidence that already reached a terminal status
 *      is not launched at all, and a child that DOES come back is adopted
 *      rather than driven — including a non-terminal one, which this process
 *      cannot distinguish from a live one another worker still owns.
 *
 * The pins are checked BEFORE anything runs. A job whose definition hash no
 * longer matches the one the claim resolved is refused rather than executed:
 * running the wrong exam under a profile's name is worse than not running it.
 *
 * And a child that ran is never traded for a tidy exit: the execution phase is
 * reported only once every child has been bound to its row, because a scorecard
 * is inserted once and never patched.
 *
 * SCOPE: eval children only. The conformance and auth-probe children, and the
 * write-manifest enforcement a `test_write` cell needs, are separate lanes.
 *
 * Gated by `BENCH_WORKER_ENABLED === '1'`. That gate stops this process from
 * CLAIMING work; the feature's own switch is the backend's
 * `BENCHMARK_RUNS_ENABLED`, which 404s these routes and parks the loop on a
 * slow poll when off.
 */

import { WEB_CALL_TIMEOUT_MS } from "../config.js";
import { logger } from "../utils/logger";
import { createAuthorizedManager } from "../routes/web/auth.js";
import {
  prepareEvalRun,
  shouldSkipExecution,
} from "../routes/shared/evals.js";
import { createConcurrencyLimiter } from "./evals-runner.js";

const BENCH_SERVICE_BASE = "/internal/v1/bench";

const POLL_INTERVAL_MS = 15_000;
const POLL_JITTER_MS = 5_000;
/** Backoff after claim/transport errors so a broken backend isn't hammered. */
const ERROR_BACKOFF_MS = 60_000;
/** Per-request cap on service-route calls so a stalled Convex can't wedge the loop. */
const SERVICE_ROUTE_TIMEOUT_MS = 15_000;

/**
 * Heartbeat cadence, from the product spec. The backend treats a claim as
 * stale at 90s, so 20s leaves room for three consecutive misses before a
 * healthy worker has its job taken away mid-run.
 */
const HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * How many read-only cells may be in flight at once.
 *
 * Two, not "as many as the matrix has". Every cell is a full agentic suite
 * against a server that did not ask to be load-tested, and the number is about
 * the TARGET's experience rather than this process's capacity.
 */
const MAX_CONCURRENT_READ_ONLY_CELLS = 2;

/** The grant travels as a request header; it is never a body field. */
const BENCHMARK_GRANT_HEADER = "x-mcpjam-benchmark-grant";

/**
 * Backoff between attempts to bind a finished child to its evidence row.
 *
 * Short and bounded. The attach is the one write whose loss is not recoverable
 * by looking again — a child that ran but was never pointed at is invisible to
 * a scorecard that gets written exactly once — so a transient blip is worth
 * riding out. It is bounded because the fallback (hand the job back and let a
 * later attempt re-attach) is a real recovery, not a last resort, and the
 * heartbeat keeps the lease alive only for as long as this worker is useful.
 */
const ATTACH_RETRY_DELAYS_MS = [1_000, 3_000];

/** Evidence statuses that mean the row is settled and owes no child. */
const TERMINAL_EVIDENCE_STATUSES = new Set([
  "completed",
  "failed",
  "unavailable",
  "not_applicable",
]);

/** Run statuses past which there is nothing left to launch. */
const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "provisional",
  "partial",
  "insufficient_evidence",
  "failed",
  "cancelled",
]);

/**
 * How to launch one matrix cell, resolved BACKEND-SIDE from the pinned
 * definition.
 *
 * The worker does not translate a definition into launch parameters, and that
 * is deliberate: the definition is what the run's hashes pin, so the mapping
 * from a cell to a model + client profile has to be reproducible from the pins
 * alone. Here it is data.
 */
export type BenchmarkEvalCell = {
  cellId: string;
  /** The exam the definition pins. */
  suiteId: string;
  /** Project environment pinning the cell's model. */
  environmentId?: string | null;
  /** Named host config pinning the cell's client profile (harness vs emulated). */
  namedHostId?: string | null;
  /**
   * Whether this cell's exam contains a write case.
   *
   * ABSENT MEANS SERIAL. Unknown side effects are the case that must not be
   * run alongside anything else: two concurrent write cells create artifacts
   * on a third party's server at the same time, and a list-style case then
   * observes its sibling's. Losing parallelism costs wall clock; guessing
   * `read_only` costs someone else's data.
   */
  writeCases?: boolean;
};

/**
 * One rostered piece of evidence and its current status, as of the claim.
 *
 * The roster is what makes resume possible: a partially executed matrix is
 * otherwise indistinguishable from a complete one, because in both cases the
 * only children that exist are the ones that ran.
 */
export type BenchmarkRosterEntry = {
  evidenceKey: string;
  kind:
    | "auth_probe"
    | "conformance_run"
    | "claude_readiness"
    | "openai_readiness"
    | "eval_run";
  status:
    | "expected"
    | "running"
    | "completed"
    | "failed"
    | "unavailable"
    | "not_applicable";
  required: boolean;
  repetitions?: number;
  /** The child already bound to this row, on a resume. */
  testSuiteRunId?: string | null;
  /** Present on `eval_run` rows only. */
  evalCell?: BenchmarkEvalCell;
};

/**
 * The claim payload, HAND-MIRRORED from the backend's claim httpAction. The
 * two repos share no types, so this shape IS the contract: adding a field is a
 * two-repo change, and unknown fields on the wire are ignored rather than
 * rejected.
 */
export type ClaimedBenchmarkJob = {
  jobId: string;
  benchmarkRunId: string;
  organizationId: string;
  projectId: string;
  /** The ONE saved server this run measures. */
  serverId: string;
  serverName?: string;
  /**
   * The lease generation this claim won. Every write carries it; the backend
   * refuses a stale one with 409 `lease_lost`.
   */
  leaseGeneration: number;
  /** The definition hash the JOB was enqueued against. */
  definitionHash: string;
  /** The hashes the CLAIM resolved. Compared against the job's before anything runs. */
  pins: {
    definitionHash: string;
    consentHash?: string;
    caseMetadataHash?: string;
    suiteRevision?: string;
  };
  roster: BenchmarkRosterEntry[];
  /**
   * The execution grant (`purpose: 'benchmark-execution'`), forwarded verbatim
   * to `/stream`. NEVER parsed here for authorization — the worker is not the
   * verifier, and a worker that reads claims out of a token it merely carries
   * is one refactor away from trusting them.
   */
  grant: string;
  /**
   * The benchmark-scoped bearer the children run as. Scoped to this run's
   * project + server backend-side, so it is not an organization-wide
   * credential even though it is used like one here.
   */
  runnerBearer: string;
};

/** What a heartbeat answers. Three of the four fields are stop signals. */
export type BenchmarkHeartbeat = {
  leaseOk: boolean;
  cancelRequested?: boolean;
  budgetStatus?: "active" | "exhausted" | "settled";
  runStatus?: string;
  /**
   * A reissued grant, when the current one is close enough to expiry that a
   * long cell would outlive it. Adopted in place — see `grantHeaders` below.
   */
  grant?: string;
};

/**
 * The backend no longer considers this worker the holder of the claim.
 *
 * Distinct from a transport failure on purpose: a failed REQUEST is worth
 * retrying on the next beat, whereas a lost LEASE means another worker is
 * already driving this job. Every further child launched from here is a second
 * charge for evidence the run will get anyway.
 */
export class LeaseLostError extends Error {
  constructor(readonly reason: string) {
    super(`lease lost: ${reason}`);
    this.name = "LeaseLostError";
  }
}

/**
 * The claim cannot be executed as given — the pins disagree, or a rostered
 * cell carries no launch spec.
 *
 * Never retried: re-claiming produces the same claim. The job is aborted with
 * the reason so the backend can fail it rather than cycling it through its
 * three attempts.
 */
export class JobUnexecutableError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "JobUnexecutableError";
  }
}

export function isBenchWorkerEnabled(): boolean {
  return process.env.BENCH_WORKER_ENABLED === "1";
}

function requiredEnv(): { convexUrl: string; serviceToken: string } | null {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  const serviceToken = process.env.INSPECTOR_SERVICE_TOKEN;
  if (!convexUrl || !serviceToken) return null;
  return { convexUrl, serviceToken };
}

type ServiceRouteResponse = { status: number; body: any };

async function postServiceRoute(
  path: string,
  body: Record<string, unknown>,
): Promise<ServiceRouteResponse> {
  const env = requiredEnv();
  if (!env) {
    throw new Error(
      "Bench worker requires CONVEX_HTTP_URL and INSPECTOR_SERVICE_TOKEN",
    );
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SERVICE_ROUTE_TIMEOUT_MS);
  // The deadline stays armed through the BODY read: a response that stalls
  // mid-body would otherwise hold a slot for as long as the socket stays open.
  try {
    const response = await fetch(`${env.convexUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-inspector-service-token": env.serviceToken,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let parsed: any = null;
    try {
      parsed = await response.json();
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(
          `bench route ${path} timed out after ${SERVICE_ROUTE_TIMEOUT_MS}ms while reading the response body`,
          { cause: error },
        );
      }
      // Otherwise tolerated; the status carries the signal.
    }
    return { status: response.status, body: parsed };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * A 404 that means "this deployment has benchmark runs switched off", as
 * opposed to "that specific thing is missing".
 *
 * The convention the relay router established: a route that is DEPLOYED says a
 * missing entity with its own envelope (`{ ok: false, … }`), so a bare routing
 * 404 — a flag that is off, a Convex that has not shipped these routes yet — is
 * the feature not being enabled. Getting this backwards would crash-loop the
 * worker against a deployment that simply has not flipped the flag.
 */
function isFeatureDisabled(status: number, body: any): boolean {
  return status === 404 && body?.ok !== false;
}

/** Whether a write route refused us because somebody else holds the lease. */
function isLeaseLostResponse(status: number, body: any): boolean {
  return status === 409 && body?.error === "lease_lost";
}

/**
 * Every failure below names the route and the status, and NEVER the response
 * body.
 *
 * The claim and the heartbeat answer with the execution grant and the runner
 * bearer in them, and these messages reach the logs, Sentry, and the abort
 * reason the backend stores. A credential that lands in any of those cannot be
 * recalled from them, and a status code is what actually diagnoses a broken
 * route anyway.
 */

async function claimNext(
  claimedBy: string,
): Promise<ClaimedBenchmarkJob | null | "disabled"> {
  const { status, body } = await postServiceRoute(
    `${BENCH_SERVICE_BASE}/jobs/claim`,
    { claimedBy },
  );
  if (isFeatureDisabled(status, body)) return "disabled";
  if (status !== 200 || !body?.ok) {
    throw new Error(`claim failed (${status})`);
  }
  return (body.claimed as ClaimedBenchmarkJob | null) ?? null;
}

/**
 * Refresh the lease, and THROW if the backend refused the REQUEST.
 *
 * A silently-discarded status is the dangerous version of this call: the
 * interval would read every rejected heartbeat as a success, and the worker
 * would keep launching paid children for a job the backend has already handed
 * to somebody else.
 *
 * Whether the answer's `leaseOk` says we still hold the claim is the CALLER's
 * to read — one place interprets the payload, and it is the same place that
 * reads `cancelRequested` and `budgetStatus`.
 */
async function sendHeartbeat(
  job: ClaimedBenchmarkJob,
  claimedBy: string,
): Promise<BenchmarkHeartbeat> {
  const { status, body } = await postServiceRoute(
    `${BENCH_SERVICE_BASE}/jobs/heartbeat`,
    {
      jobId: job.jobId,
      benchmarkRunId: job.benchmarkRunId,
      gen: job.leaseGeneration,
      claimedBy,
    },
  );
  if (isLeaseLostResponse(status, body)) {
    throw new LeaseLostError("heartbeat rejected the lease generation");
  }
  if (status !== 200 || !body?.ok) {
    throw new Error(`heartbeat rejected (${status})`);
  }
  return (body.result ?? body) as BenchmarkHeartbeat;
}

/**
 * Bind a child run to its rostered evidence row.
 *
 * Called for a child that FAILED as well as one that passed: the row carries
 * the pointer, and the backend derives the terminal status from the child
 * itself. An unattached failure is invisible until a sweep notices it, which
 * turns a known failure into a coverage gap.
 */
async function attachEvalEvidence(args: {
  job: ClaimedBenchmarkJob;
  evidenceKey: string;
  cellId: string;
  testSuiteRunId: string;
}): Promise<void> {
  const { status, body } = await postServiceRoute(
    `${BENCH_SERVICE_BASE}/evidence/attach`,
    {
      jobId: args.job.jobId,
      benchmarkRunId: args.job.benchmarkRunId,
      gen: args.job.leaseGeneration,
      evidenceKey: args.evidenceKey,
      cellId: args.cellId,
      testSuiteRunId: args.testSuiteRunId,
    },
  );
  if (isLeaseLostResponse(status, body)) {
    throw new LeaseLostError("attach rejected the lease generation");
  }
  if (status !== 200 || !body?.ok) {
    throw new Error(`evidence attach rejected (${status})`);
  }
}

/**
 * Report that every child this worker owed has been launched and settled.
 *
 * This is the EXECUTION phase ending, not the run: the backend moves the run to
 * `awaiting_evidence` and owns finalization from there. The job's lease
 * deliberately outlives this call, so a worker lost during finalization is
 * swept and the run re-finalized rather than orphaned.
 */
async function reportExecutionComplete(args: {
  job: ClaimedBenchmarkJob;
  claimedBy: string;
  stoppedReason?: string;
}): Promise<void> {
  const { status, body } = await postServiceRoute(
    `${BENCH_SERVICE_BASE}/jobs/execution-complete`,
    {
      jobId: args.job.jobId,
      benchmarkRunId: args.job.benchmarkRunId,
      gen: args.job.leaseGeneration,
      claimedBy: args.claimedBy,
      ...(args.stoppedReason ? { stoppedReason: args.stoppedReason } : {}),
    },
  );
  if (isLeaseLostResponse(status, body)) {
    throw new LeaseLostError("execution-complete rejected the lease generation");
  }
  if (status !== 200 || !body?.ok) {
    throw new Error(`execution-complete rejected (${status})`);
  }
}

/**
 * Hand the job back. The backend decides between another attempt and failing
 * the run; `retryable: false` is how a claim we can never execute (mismatched
 * pins) says so, rather than burning all three attempts on the same refusal.
 */
async function abortJob(args: {
  job: ClaimedBenchmarkJob;
  claimedBy: string;
  reason: string;
  retryable: boolean;
}): Promise<void> {
  const { status, body } = await postServiceRoute(
    `${BENCH_SERVICE_BASE}/jobs/abort`,
    {
      jobId: args.job.jobId,
      benchmarkRunId: args.job.benchmarkRunId,
      gen: args.job.leaseGeneration,
      claimedBy: args.claimedBy,
      reason: args.reason.slice(0, 500),
      retryable: args.retryable,
    },
  );
  if (status !== 200 || !body?.ok) {
    logger.warn("[bench] abort rejected", {
      jobId: args.job.jobId,
      status,
    });
  }
}

/**
 * Everything the claim has to satisfy before a single child is launched.
 *
 * The definition hash is the important one. A job carries the hash it was
 * enqueued against and the claim carries the hash the backend just resolved;
 * when they disagree, the definition was republished between admission and
 * execution, and the quote, the consent and the roster all describe a different
 * exam than the one that would run. Refusing is the only honest answer —
 * executing would publish a scorecard under a profile the payer never saw.
 */
export function assertClaimExecutable(job: ClaimedBenchmarkJob): void {
  if (!job.grant) {
    throw new JobUnexecutableError("the claim carried no execution grant");
  }
  if (!job.runnerBearer) {
    throw new JobUnexecutableError("the claim carried no runner bearer");
  }
  // The parent id is what LICENSES this job's children to carry the hidden
  // `benchmark` source — `startTestSuiteRun` refuses that source without it.
  // The type says `string`, but the claim is hand-mirrored from the wire and
  // unknown/absent fields are ignored rather than rejected, so a backend that
  // stopped sending it would otherwise reach Convex as `undefined` and fail
  // every cell with an opaque FORBIDDEN, one lease and one MCP session in.
  if (!job.benchmarkRunId) {
    throw new JobUnexecutableError("the claim carried no benchmark run id");
  }
  if (job.pins?.definitionHash !== job.definitionHash) {
    throw new JobUnexecutableError(
      `definition hash changed between admission and claim (job ${job.definitionHash}, claim ${job.pins?.definitionHash})`,
    );
  }
  for (const entry of job.roster ?? []) {
    if (entry.kind !== "eval_run") continue;
    if (!entry.evalCell?.cellId || !entry.evalCell?.suiteId) {
      throw new JobUnexecutableError(
        `rostered cell "${entry.evidenceKey}" carries no launch spec`,
      );
    }
  }
}

/**
 * The child's idempotency key.
 *
 * `benchmarkRunId + evidenceKey`, both pure functions of the run and the pinned
 * definition — so a redelivered claim, a restarted worker and a requeued job
 * all compute the SAME key and join the child that already exists instead of
 * starting a second one.
 */
export function evalChildIdempotencyKey(
  benchmarkRunId: string,
  evidenceKey: string,
): string {
  return `${benchmarkRunId}:${evidenceKey}`;
}

export type RunEvalCellArgs = {
  job: ClaimedBenchmarkJob;
  entry: BenchmarkRosterEntry;
  cell: BenchmarkEvalCell;
  /**
   * The grant header object, shared by every cell of this job and mutated in
   * place when a heartbeat reissues the grant — see `executeClaimedJob`.
   */
  grantHeaders: Record<string, string>;
};

/**
 * Run ONE matrix cell as an eval child.
 *
 * The connection is opened with the run's own scoped bearer, so stored OAuth
 * for the measured server resolves the ordinary way and this worker never sees
 * a credential it could point somewhere else.
 */
async function defaultRunEvalCell(
  args: RunEvalCellArgs,
): Promise<{ runId: string; executed: boolean }> {
  const { job, cell } = args;
  // Empty caller context = plain-JWT caller (locked by the caller-context
  // contract test); the runner bearer is the principal.
  const authorized = await createAuthorizedManager(
    {},
    job.runnerBearer,
    job.projectId,
    [job.serverId],
    WEB_CALL_TIMEOUT_MS,
    undefined,
    undefined,
    job.serverName ? { serverNames: [job.serverName] } : undefined,
  );

  try {
    const prepared = await prepareEvalRun(authorized.manager, {
      suiteId: cell.suiteId,
      projectId: job.projectId,
      tests: [],
      serverIds: [job.serverId],
      ...(job.serverName ? { serverNames: [job.serverName] } : {}),
      convexAuthToken: job.runnerBearer,
      suiteRerun: true,
      // ── PROVENANCE IS A CAPABILITY, NOT A LABEL ──────────────────────────
      //
      // `source: 'benchmark'` hides the child from every project list and
      // suppresses its notifications, so the backend stopped taking the word
      // for it (mcpjam-backend#1160): `startTestSuiteRun` now demands the
      // `benchmarkRunId` of a LIVE parent run the caller can already reach,
      // and refuses a missing or terminal one.
      //
      // Straight pass-through from the claim — the same id the idempotency key
      // below is derived from. Nothing is looked up or re-derived: the parent
      // this cell belongs to is a fact of the job, and re-deriving it is how a
      // child ends up filed under the wrong benchmark.
      source: "benchmark",
      benchmarkRunId: job.benchmarkRunId,
      ...(cell.environmentId ? { environmentId: cell.environmentId } : {}),
      ...(cell.namedHostId ? { namedHostId: cell.namedHostId } : {}),
      // The CELL's pinned repetition count, not the suite's `runs` default.
      // The scorer's `minimumRepetitionsPerRequiredCell` is a publication
      // floor, so a cell declared at 3 that runs once is not merely thinner
      // evidence — it can never clear the floor, and every hosted run of that
      // definition comes out provisional. Forwarded as-is rather than clamped:
      // the eval surface caps an override at 10, and a definition pinning more
      // should fail loudly here instead of silently under-observing.
      ...(Number.isInteger(args.entry.repetitions) &&
      (args.entry.repetitions as number) >= 1
        ? { iterationOverride: args.entry.repetitions }
        : {}),
      // The run's model calls are billed against the benchmark budget, and the
      // grant is what tells `/stream` which run to charge. Passed by reference:
      // the object is shared with the heartbeat, which rotates the grant inside
      // it when the backend reissues one.
      extraHeaders: args.grantHeaders,
      idempotencyKey: evalChildIdempotencyKey(
        job.benchmarkRunId,
        args.entry.evidenceKey,
      ),
    });

    // ── A REPLAYED CHILD IS NEVER EXECUTED FROM HERE ─────────────────────
    //
    // `deduped` means the idempotency key matched a run that already exists,
    // so THIS process did not create it — and a benchmark must not drive a
    // child it did not start, whatever state that child is in.
    //
    // `shouldSkipExecution` alone is not enough, and the gap is specific: it
    // answers false for a deduped run still `running`, because for ORDINARY
    // evals a replay of a non-terminal run is more likely a crashed process
    // worth resuming than a live one worth leaving alone. That trade inverts
    // here. A lease expires on a network partition just as readily as on a
    // dead worker, so the reclaiming worker cannot tell "abandoned" from
    // "still being driven" — and guessing wrong runs the exam twice against
    // somebody else's server and bills the budget for both.
    //
    // So a replay is adopted, never re-driven: the pointer is returned, the
    // row gets attached, and whichever worker actually owns the child carries
    // it to a terminal status. A child that really was abandoned degrades to a
    // coverage gap (the backend's evidence resync and the stale-eval-run
    // watchdog terminalize it), which is the cheaper of the two mistakes.
    //
    // Driving an abandoned child to completion needs a liveness signal this
    // process does not have; see the `claim-child` route requested on the
    // review thread.
    if (prepared.deduped === true) {
      logger.info(
        shouldSkipExecution(prepared)
          ? "[bench] cell already ran — adopting the finished child"
          : "[bench] cell child is not terminal — adopting, not driving it",
        {
          benchmarkRunId: job.benchmarkRunId,
          cellId: cell.cellId,
          runId: prepared.runId,
          status: prepared.status,
        },
      );
      return { runId: prepared.runId, executed: false };
    }

    try {
      await prepared.execute();
    } catch (error) {
      // The run EXISTS, and the eval runner owns terminal run status — it
      // finalizes a failed run itself before rethrowing. Losing the id here
      // would leave the evidence row unattached, and a rostered cell that
      // never got a pointer reads as a cell that never started rather than
      // one that failed against the target.
      logger.error("[bench] cell run failed", error, {
        benchmarkRunId: job.benchmarkRunId,
        cellId: cell.cellId,
        runId: prepared.runId,
      });
    }
    return { runId: prepared.runId, executed: true };
  } finally {
    // ALWAYS, including the error path: an MCP session left open holds a socket
    // against a third party's server for as long as this process lives.
    await authorized.manager.disconnectAllServers().catch(() => {});
  }
}

/** Test seam: what `defaultRunEvalCell` hands to the eval pipeline IS the contract. */
export const defaultRunEvalCellForTests = () => defaultRunEvalCell;

/**
 * Test seam: the 404 convention is the whole reason this worker can ship
 * before the backend flag flips, and it lives at the wire.
 */
export const claimNextForTests = claimNext;

/**
 * Injectable collaborators. Every external effect the executor performs is one
 * of these, so the orchestration tests drive real control flow — the heartbeat
 * lifecycle, the concurrency split, the resume path — without a Convex
 * deployment or an MCP server.
 */
export type BenchExecutionDeps = {
  runEvalCell: typeof defaultRunEvalCell;
  attachEvidence: typeof attachEvalEvidence;
  executionComplete: typeof reportExecutionComplete;
  abort: typeof abortJob;
  heartbeat: (
    job: ClaimedBenchmarkJob,
    claimedBy: string,
  ) => Promise<BenchmarkHeartbeat>;
  heartbeatIntervalMs: number;
};

function defaultDeps(): BenchExecutionDeps {
  return {
    runEvalCell: defaultRunEvalCell,
    attachEvidence: attachEvalEvidence,
    executionComplete: reportExecutionComplete,
    abort: abortJob,
    heartbeat: sendHeartbeat,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  };
}

/** Execute one claimed job end to end. NEVER throws. */
export async function executeClaimedJob(
  claimed: ClaimedBenchmarkJob,
  claimedBy: string,
  overrides?: Partial<BenchExecutionDeps>,
): Promise<void> {
  const deps: BenchExecutionDeps = { ...defaultDeps(), ...overrides };
  const logContext = {
    jobId: claimed.jobId,
    benchmarkRunId: claimed.benchmarkRunId,
    projectId: claimed.projectId,
    serverId: claimed.serverId,
  };

  // Set once the backend tells us the claim is no longer ours. Checked at every
  // step boundary below, and never cleared: a lease does not come back.
  let leaseLost: LeaseLostError | null = null;
  /**
   * Why we stopped LAUNCHING, once something says to. In-flight children still
   * finish — their evidence is already paid for.
   */
  const windDown: { reason?: string } = {};

  /**
   * ONE object for the whole job, mutated in place rather than replaced.
   *
   * The engine reads `extraHeaders` per step, so writing a reissued grant into
   * this object reaches every step that follows — in children that are already
   * running. Handing each cell its own copy would pin an in-flight cell to a
   * grant that has since expired.
   */
  const grantHeaders: Record<string, string> = {
    [BENCHMARK_GRANT_HEADER]: claimed.grant,
  };

  const heartbeat = setInterval(() => {
    void deps
      .heartbeat(claimed, claimedBy)
      .then((result) => {
        // DEFINITIVE, not transient. The backend has handed this job to another
        // worker; every child launched from here is a second charge for
        // evidence the run is going to get anyway.
        if (result?.leaseOk === false) {
          throw new LeaseLostError(
            "the backend no longer holds this claim for us",
          );
        }
        if (result?.grant) grantHeaders[BENCHMARK_GRANT_HEADER] = result.grant;
        // None of these is a lease loss: the job is still ours, there is just
        // nothing left worth starting.
        const reason = result?.cancelRequested
          ? "cancelled"
          : result?.budgetStatus && result.budgetStatus !== "active"
            ? `budget_${result.budgetStatus}`
            : result?.runStatus && TERMINAL_RUN_STATUSES.has(result.runStatus)
              ? `run_${result.runStatus}`
              : undefined;
        if (reason && !windDown.reason) {
          windDown.reason = reason;
          logger.info("[bench] winding down; not launching further children", {
            ...logContext,
            stoppedReason: reason,
          });
        }
      })
      .catch((error) => {
        if (error instanceof LeaseLostError) {
          // Definitive. Stop beating and let the next step boundary bail out.
          leaseLost = error;
          clearInterval(heartbeat);
          logger.warn("[bench] lease lost; abandoning this job", {
            ...logContext,
            reason: error.reason,
          });
          return;
        }
        logger.warn("[bench] heartbeat failed", {
          ...logContext,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, deps.heartbeatIntervalMs);
  // Don't hold the event loop open on shutdown.
  (heartbeat as unknown as { unref?: () => void }).unref?.();

  /** Throw out of the pipeline if the claim stopped being ours. */
  const assertLeaseHeld = () => {
    if (leaseLost) throw leaseLost;
  };

  try {
    assertClaimExecutable(claimed);
    assertLeaseHeld();

    const cells = claimed.roster
      .filter(
        (entry) =>
          entry.kind === "eval_run" &&
          entry.evalCell &&
          // Terminal rows owe nothing. Launching one would pay a second time
          // for evidence the run already holds.
          !TERMINAL_EVIDENCE_STATUSES.has(entry.status),
      )
      .sort((a, b) => (a.evidenceKey < b.evidenceKey ? -1 : 1));

    // READ-ONLY FIRST, deliberately. A cancellation or an exhausted budget
    // stops launching wherever it lands, and the cells worth losing to that are
    // the ones that would have written to somebody else's server.
    //
    // Read-only is the EXPLICIT `false`, never the absence — see `writeCases`.
    const readOnly = cells.filter(
      (entry) => entry.evalCell?.writeCases === false,
    );
    const writing = cells.filter(
      (entry) => entry.evalCell?.writeCases !== false,
    );

    /**
     * Children that ran and could not be bound to their row: evidenceKey →
     * runId. Non-empty means the execution phase must NOT be reported.
     */
    const unattached = new Map<string, string>();

    /**
     * Bind the child, retrying a transient refusal.
     *
     * A lost lease is never retried — the write would be refused every time,
     * and the whole point of standing down is to stop writing.
     */
    const attachWithRetry = async (
      entry: BenchmarkRosterEntry,
      cellId: string,
      runId: string,
    ): Promise<void> => {
      for (let attempt = 0; ; attempt++) {
        try {
          await deps.attachEvidence({
            job: claimed,
            evidenceKey: entry.evidenceKey,
            cellId,
            testSuiteRunId: runId,
          });
          return;
        } catch (error) {
          if (error instanceof LeaseLostError) throw error;
          if (attempt >= ATTACH_RETRY_DELAYS_MS.length) throw error;
          logger.warn("[bench] evidence attach failed; retrying", {
            ...logContext,
            cellId,
            runId,
            attempt: attempt + 1,
            error: error instanceof Error ? error.message : String(error),
          });
          await sleep(ATTACH_RETRY_DELAYS_MS[attempt]);
          assertLeaseHeld();
        }
      }
    };

    const runCell = async (entry: BenchmarkRosterEntry): Promise<void> => {
      if (windDown.reason || leaseLost) return;
      const cell = entry.evalCell!;
      let runId: string | null = null;
      try {
        assertLeaseHeld();
        const result = await deps.runEvalCell({
          job: claimed,
          entry,
          cell,
          grantHeaders,
        });
        runId = result.runId;
      } catch (error) {
        if (error instanceof LeaseLostError) throw error;
        // No child was created at all (the connection failed, the suite is
        // gone). There is no pointer to attach; the row stays `expected` and
        // the backend's roster sweep degrades it to a coverage gap.
        logger.error("[bench] cell could not be launched", error, {
          ...logContext,
          cellId: cell.cellId,
        });
      }

      // Attached whether the child passed or FAILED: the backend derives the
      // row's terminal status from the child itself, so a failed run still has
      // to be pointed at.
      if (!runId) return;
      assertLeaseHeld();
      try {
        await attachWithRetry(entry, cell.cellId, runId);
      } catch (error) {
        if (error instanceof LeaseLostError) throw error;
        // AN ATTACH THAT NEVER LANDED LOSES A CHILD THAT REALLY RAN.
        //
        // The row stays `expected` while a completed exam sits beside it, and
        // the scorecard is written once and never patched — so reporting the
        // execution phase over the top of this would bake the loss in
        // permanently. Recorded instead, and checked before the phase is
        // reported: the job goes back for another attempt, and the resumed
        // worker adopts the same child (same idempotency key) and retries the
        // attach without re-running anything.
        unattached.set(entry.evidenceKey, runId);
        logger.error("[bench] attaching cell evidence failed", error, {
          ...logContext,
          cellId: cell.cellId,
          runId,
        });
      }
    };

    /** Collect a cell's failure without letting it abandon its siblings. */
    const settle = async (entry: BenchmarkRosterEntry): Promise<void> => {
      try {
        await runCell(entry);
      } catch (error) {
        if (error instanceof LeaseLostError) {
          leaseLost ??= error;
          return;
        }
        logger.error("[bench] cell aborted", error, {
          ...logContext,
          cellId: entry.evalCell?.cellId,
        });
      }
    };

    const limit = createConcurrencyLimiter(MAX_CONCURRENT_READ_ONLY_CELLS);
    await Promise.all(readOnly.map((entry) => limit(() => settle(entry))));

    assertLeaseHeld();

    // STRICTLY one at a time, and only after every read-only cell has settled.
    // A write case creates artifacts named for this run and then asserts over
    // what it can see; a sibling writing concurrently is indistinguishable from
    // the target leaking another tenant's data.
    for (const entry of writing) {
      assertLeaseHeld();
      await settle(entry);
    }

    assertLeaseHeld();

    // REPORTING THE PHASE OVER AN UNATTACHED CHILD IS THE ONE UNRECOVERABLE
    // MISTAKE HERE. `execution-complete` moves the run to `awaiting_evidence`
    // and hands finalization to the backend, and a scorecard is inserted once
    // and never patched — so a child that ran but never got pointed at is
    // dropped from the result for good, silently, with the roster showing a
    // coverage gap that never existed. Handing the job back instead costs one
    // more attempt, and the re-attempt adopts the same children rather than
    // re-running them.
    if (unattached.size > 0) {
      throw new Error(
        `${unattached.size} eval child(ren) ran but could not be attached: ${[
          ...unattached.keys(),
        ].join(", ")}`,
      );
    }

    await deps.executionComplete({
      job: claimed,
      claimedBy,
      ...(windDown.reason ? { stoppedReason: windDown.reason } : {}),
    });
  } catch (error) {
    if (error instanceof LeaseLostError) {
      // WRITE NOTHING. Another worker owns this job, and an abort from here
      // would hand back a lease we no longer hold — cancelling their run.
      logger.warn("[bench] abandoned after losing the lease", {
        ...logContext,
        reason: error.reason,
      });
      return;
    }
    const retryable = !(error instanceof JobUnexecutableError);
    const reason = error instanceof Error ? error.message : String(error);
    logger.error("[bench] job execution failed", error, logContext);
    await deps
      .abort({ job: claimed, claimedBy, reason, retryable })
      .catch((abortError) => {
        // Best effort: an unreported job is recovered by the backend's stale
        // lease sweep.
        logger.warn("[bench] reporting the abort failed", {
          ...logContext,
          error:
            abortError instanceof Error
              ? abortError.message
              : String(abortError),
        });
      });
  } finally {
    clearInterval(heartbeat);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  // Checked BEFORE the listener goes on: an `abort` that already fired never
  // fires again, so a listener added afterwards waits out the whole delay —
  // which may be the 60s backoff, long past the caller's shutdown deadline.
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      done();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface BenchWorkerHandle {
  /** Aborts polling and resolves once the loop (incl. an in-flight job) settles. */
  stop: () => Promise<void>;
}

/**
 * Start the polling loop. ONE job in flight per replica; the fleet-wide cap
 * lives in the claim mutation, because Railway may run several replicas and
 * this loop knows nothing about its siblings.
 */
export function startBenchWorker(options?: {
  claimedBy?: string;
  /** Test seams: override the claim/execute pair. */
  claim?: typeof claimNext;
  execute?: (
    claimed: ClaimedBenchmarkJob,
    claimedBy: string,
  ) => Promise<void>;
}): BenchWorkerHandle {
  const abort = new AbortController();
  const claimedBy =
    options?.claimedBy ??
    `inspector-bench-${process.env.RAILWAY_REPLICA_ID ?? process.pid}`;
  const claim = options?.claim ?? claimNext;
  const execute =
    options?.execute ??
    ((claimed: ClaimedBenchmarkJob, by: string) =>
      executeClaimedJob(claimed, by));

  if (!requiredEnv()) {
    logger.warn(
      "[bench] worker enabled but CONVEX_HTTP_URL / INSPECTOR_SERVICE_TOKEN missing; not starting",
    );
    return { stop: async () => {} };
  }

  // A SEPARATE variable from `CONVEX_HTTP_URL`, read deeper: the eval pipeline
  // builds its Convex client from `CONVEX_URL`, and it throws only once a cell
  // is already launching. A deployment holding one but not the other would
  // claim a job, admit a budget against it, and fail every cell.
  if (!process.env.CONVEX_URL) {
    logger.warn(
      "[bench] worker enabled but CONVEX_URL missing; not starting (queued jobs stay claimable)",
    );
    return { stop: async () => {} };
  }

  logger.info("[bench] worker started", { claimedBy });

  const loop = (async () => {
    while (!abort.signal.aborted) {
      let waitMs = POLL_INTERVAL_MS + Math.floor(Math.random() * POLL_JITTER_MS);
      try {
        const claimed = await claim(claimedBy);
        if (claimed === "disabled") {
          // Feature off backend-side: poll slowly so flipping the env flag
          // doesn't need an Inspector restart.
          waitMs = ERROR_BACKOFF_MS;
        } else if (claimed) {
          await execute(claimed, claimedBy);
          // Drain mode: another run may be queued behind this one.
          waitMs = 1_000;
        }
      } catch (error) {
        logger.warn("[bench] poll failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        waitMs = ERROR_BACKOFF_MS;
      }
      await sleep(waitMs, abort.signal);
    }
    logger.info("[bench] worker stopped");
  })();

  return {
    stop: async () => {
      abort.abort();
      // Bounded by the caller's shutdown force-exit timer; a job that outlasts
      // it is recovered by the backend's stale-lease sweep.
      await loop;
    },
  };
}
