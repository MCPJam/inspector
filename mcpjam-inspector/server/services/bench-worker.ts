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
 * so three properties matter more here than in the sibling workers:
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
 *      is not launched at all.
 *
 *   3. A RUN TIDIES UP AFTER ITSELF. Every artifact a write case creates lands
 *      in the run's ledger as it is created, and cleanup replays that ledger in
 *      a `finally` — after every cell has disconnected, over its own
 *      connection, with no model call anywhere on the path. A run that
 *      exhausted its budget still has to remove what it left on somebody
 *      else's server, so the one thing cleanup must not depend on is the thing
 *      that ran out. Cleanup dials the TARGET rather than the backend, which is
 *      why it runs even after a lost lease: the ids are in THIS worker's ledger
 *      and no other worker can see them.
 *
 * The pins are checked BEFORE anything runs — the definition hash, and the
 * `caseMetadataHash` a write cell's manifest has to agree with. A job that no
 * longer matches what the claim resolved is refused rather than executed:
 * running the wrong exam under a profile's name, or writing under rules the
 * payer never saw, is worse than not running it.
 *
 * THE TWO NON-MODEL CHILDREN RUN FIRST. The probe and the conformance suite
 * spend no model credits, so a run whose budget is exhausted — or which is
 * cancelled halfway — still keeps the evidence that costs nothing. Running
 * them after the matrix would make the cheapest, most reusable evidence the
 * first thing a wind-down throws away.
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
import {
  cleanupBenchmarkArtifacts,
  createBenchmarkArtifactLedger,
  type ArtifactCleanupReport,
  type BenchmarkArtifactLedger,
  type BenchmarkWriteGuard,
} from "./evals/artifact-ledger.js";
import {
  assertCaseMetadataPinned,
  CaseMetadataPinMismatchError,
  type PinnedCaseSideEffects,
} from "./evals/side-effect-manifest.js";
import { createConformanceFetch } from "../routes/shared/conformance.js";
import { executePersistedConformanceRun } from "./conformance-run-executor.js";
import {
  runBenchmarkAuthProbe,
  type BenchmarkProbeEvidence,
} from "./bench-probe-child.js";
import type { ConformanceSuiteKind, OAuthConformanceConfig } from "@mcpjam/sdk";

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
  /**
   * The pinned side-effect manifests for this exam's cases, resolved
   * backend-side by `suiteHash + caseId`.
   *
   * Verified against the claim's `caseMetadataHash` before anything launches —
   * see `assertClaimExecutable`. A manifest that cannot be tied to the
   * definition the job was admitted under is not one we may enforce: the write
   * rules the payer consented to would not be the rules that ran.
   */
  caseSideEffects?: PinnedCaseSideEffects[];
};

/**
 * Where the auth-probe child dials, resolved BACKEND-SIDE from the pinned
 * target.
 *
 * The endpoint is data for the same reason a cell's model is: it is what the
 * run's hashes pin, and a worker that derived it would make the observation
 * un-reproducible from the pins.
 */
export type BenchmarkProbeSpec = {
  serverUrl: string;
};

/**
 * How to run the conformance child, resolved backend-side from the pinned
 * definition.
 *
 * `oauth` is present only for a definition that pins an `oauth-headless` exam
 * scope. Its `headlessCheckIds` names, BY ID, exactly which checks that exam
 * grades — the list is part of the hashed manifest, so the denominator a
 * scorecard is computed against is reproducible from the pins rather than from
 * whatever the harness managed on the day.
 */
export type BenchmarkConformanceSpec = {
  serverUrl: string;
  suites: ConformanceSuiteKind[];
  protocolVersion?: string;
  engineVersion?: string;
  oauth?: {
    protocolVersion: OAuthConformanceConfig["protocolVersion"];
    registrationStrategy: OAuthConformanceConfig["registrationStrategy"];
    /**
     * Headless only. Interactive OAuth needs a consent screen and a human, and
     * a hosted benchmark has neither — the checks that leg would cover are
     * recorded `could_not_run`, never faked.
     */
    auth: Extract<
      OAuthConformanceConfig["auth"],
      { mode: "headless" } | { mode: "client_credentials" }
    >;
    client?: OAuthConformanceConfig["client"];
    scopes?: string;
    customHeaders?: Record<string, string>;
    redirectUrl?: string;
    headlessCheckIds: string[];
  };
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
  /** Present on `auth_probe` rows only. */
  probeSpec?: BenchmarkProbeSpec;
  /** Present on `conformance_run` rows only. */
  conformanceSpec?: BenchmarkConformanceSpec;
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
 * Bind a persisted conformance run to its rostered evidence row.
 *
 * The same route as an eval child, and the same reason for calling it on a
 * FAILED child: the row carries the pointer and the backend derives the
 * terminal status from the run itself.
 */
async function attachConformanceEvidence(args: {
  job: ClaimedBenchmarkJob;
  evidenceKey: string;
  conformanceRunId: string;
}): Promise<void> {
  const { status, body } = await postServiceRoute(
    `${BENCH_SERVICE_BASE}/evidence/attach`,
    {
      jobId: args.job.jobId,
      benchmarkRunId: args.job.benchmarkRunId,
      gen: args.job.leaseGeneration,
      evidenceKey: args.evidenceKey,
      conformanceRunId: args.conformanceRunId,
    },
  );
  if (isLeaseLostResponse(status, body)) {
    throw new LeaseLostError("attach rejected the lease generation");
  }
  if (status !== 200 || !body?.ok) {
    throw new Error(`conformance evidence attach rejected (${status})`);
  }
}

/**
 * File what the auth probe observed.
 *
 * Its own route rather than `evidence/attach`, because the probe has no child
 * RUN to point at — the observation IS the evidence, and it is the only thing
 * on the roster that can be stamped `mcpjam_verified` on the strength of this
 * worker having made the request itself.
 *
 * A `failed` or `refused` payload is filed exactly like a completed one. The
 * backend records the row unavailable from it; suppressing the call would
 * leave the row `expected` and turn a refusal we know about into a coverage
 * gap somebody has to sweep.
 */
async function attachProbeEvidence(args: {
  job: ClaimedBenchmarkJob;
  evidenceKey: string;
  evidence: BenchmarkProbeEvidence;
}): Promise<void> {
  const { status, body } = await postServiceRoute(
    `${BENCH_SERVICE_BASE}/evidence/probe`,
    {
      jobId: args.job.jobId,
      benchmarkRunId: args.job.benchmarkRunId,
      gen: args.job.leaseGeneration,
      evidenceKey: args.evidenceKey,
      ...args.evidence,
    },
  );
  if (isLeaseLostResponse(status, body)) {
    throw new LeaseLostError("probe attach rejected the lease generation");
  }
  if (status !== 200 || !body?.ok) {
    throw new Error(`probe evidence attach rejected (${status})`);
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
  /**
   * What the run left behind on the target, for the scorecard. Reported with
   * the phase that produced it rather than on its own route: "here is how
   * execution went" is one statement, and a residue count that arrived
   * separately could be attached to a run that had already been finalized
   * without it.
   */
  cleanup?: ArtifactCleanupReport;
}): Promise<void> {
  const { status, body } = await postServiceRoute(
    `${BENCH_SERVICE_BASE}/jobs/execution-complete`,
    {
      jobId: args.job.jobId,
      benchmarkRunId: args.job.benchmarkRunId,
      gen: args.job.leaseGeneration,
      claimedBy: args.claimedBy,
      ...(args.stoppedReason ? { stoppedReason: args.stoppedReason } : {}),
      ...(args.cleanup ? { cleanup: args.cleanup } : {}),
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
 * Assemble the scorecard.
 *
 * A SEPARATE step from execution-complete, and the job's lease deliberately
 * outlives it: a worker lost between the two is swept and the run re-finalized
 * rather than orphaned in `awaiting_evidence` with a complete roster.
 */
async function finalizeBenchmarkRun(args: {
  job: ClaimedBenchmarkJob;
  claimedBy: string;
}): Promise<void> {
  const { status, body } = await postServiceRoute(
    `${BENCH_SERVICE_BASE}/runs/finalize`,
    {
      jobId: args.job.jobId,
      benchmarkRunId: args.job.benchmarkRunId,
      gen: args.job.leaseGeneration,
      claimedBy: args.claimedBy,
    },
  );
  if (isLeaseLostResponse(status, body)) {
    throw new LeaseLostError("finalize rejected the lease generation");
  }
  if (status !== 200 || !body?.ok) {
    throw new Error(`finalize rejected (${status})`);
  }
}

/**
 * Ask for the explanatory flow analysis.
 *
 * AFTER finalize, and never a precondition of it. The analyzer produces an
 * INFERRED experience artifact billed against the run's budget; a scorecard
 * must not wait on it and must not change because it failed or arrived late.
 */
async function triggerFlowAnalyzer(args: {
  job: ClaimedBenchmarkJob;
  claimedBy: string;
}): Promise<void> {
  const { status, body } = await postServiceRoute(
    `${BENCH_SERVICE_BASE}/runs/analyze`,
    {
      jobId: args.job.jobId,
      benchmarkRunId: args.job.benchmarkRunId,
      gen: args.job.leaseGeneration,
      claimedBy: args.claimedBy,
    },
  );
  if (status !== 200 || !body?.ok) {
    throw new Error(`analyzer trigger rejected (${status})`);
  }
}

/**
 * Release the job. LAST, always.
 *
 * The backend only accepts it once the run is terminal, and holding the lease
 * until then is what lets a sweep re-finalize a run whose worker died between
 * `awaiting_evidence` and a scorecard.
 */
async function completeBenchmarkJob(args: {
  job: ClaimedBenchmarkJob;
  claimedBy: string;
}): Promise<void> {
  const { status, body } = await postServiceRoute(
    `${BENCH_SERVICE_BASE}/jobs/complete`,
    {
      jobId: args.job.jobId,
      benchmarkRunId: args.job.benchmarkRunId,
      gen: args.job.leaseGeneration,
      claimedBy: args.claimedBy,
    },
  );
  if (isLeaseLostResponse(status, body)) {
    throw new LeaseLostError("complete rejected the lease generation");
  }
  if (status !== 200 || !body?.ok) {
    throw new Error(`job complete rejected (${status})`);
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
  if (job.pins?.definitionHash !== job.definitionHash) {
    throw new JobUnexecutableError(
      `definition hash changed between admission and claim (job ${job.definitionHash}, claim ${job.pins?.definitionHash})`,
    );
  }
  for (const entry of job.roster ?? []) {
    if (entry.kind !== "eval_run") continue;
    const cell = entry.evalCell;
    if (!cell?.cellId || !cell?.suiteId) {
      throw new JobUnexecutableError(
        `rostered cell "${entry.evidenceKey}" carries no launch spec`,
      );
    }
    // A write cell with no manifest has no enforceable bound on what it may
    // create or mutate on a third party's server. `publishDefinition` refuses
    // to publish one; a claim that produced one anyway is a contract breach,
    // and running it unbounded is the one outcome worse than not running it.
    if (cell.writeCases === true && !cell.caseSideEffects?.length) {
      throw new JobUnexecutableError(
        `write cell "${entry.evidenceKey}" carries no side-effect manifest`,
      );
    }
    // Only a cell that HAS manifests needs the pin: a read-only exam declares
    // nothing, and demanding a `caseMetadataHash` for it would refuse every
    // definition that has no write case to describe.
    if (!cell.caseSideEffects?.length) continue;
    try {
      assertCaseMetadataPinned({
        resolved: cell.caseSideEffects,
        expectedCaseMetadataHash: job.pins?.caseMetadataHash,
        ...(job.pins?.suiteRevision
          ? { expectedSuiteHash: job.pins.suiteRevision }
          : {}),
      });
    } catch (error) {
      if (error instanceof CaseMetadataPinMismatchError) {
        throw new JobUnexecutableError(
          `cell "${entry.evidenceKey}": ${error.message}`,
        );
      }
      throw error;
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
  /**
   * The RUN's artifact ledger, shared by every cell and by the cleanup that
   * follows them. One per job, never per cell: an artifact created by one cell
   * has to be removable after every cell has finished.
   */
  ledger: BenchmarkArtifactLedger;
};

/**
 * The write guard for one cell, or nothing when the cell declares no writes.
 *
 * Read-only cells get no guard at all rather than an empty one: an empty guard
 * would wrap every allowed tool for no reason, and `requireManifest` on a cell
 * with nothing to declare would refuse calls the exam is supposed to make.
 */
function buildWriteGuard(
  cell: BenchmarkEvalCell,
  benchmarkRunId: string,
  ledger: BenchmarkArtifactLedger,
): BenchmarkWriteGuard | undefined {
  if (!cell.caseSideEffects?.length) return undefined;
  const sideEffectsByCaseId: Record<
    string,
    PinnedCaseSideEffects["sideEffects"]
  > = {};
  for (const entry of cell.caseSideEffects) {
    sideEffectsByCaseId[entry.caseId] = entry.sideEffects;
  }
  return {
    benchmarkRunId,
    sideEffectsByCaseId,
    // Fail-closed only for a cell that actually writes. A read case inside a
    // write exam still has to find its own manifest entry; one that does not
    // is refused rather than run unbounded.
    requireManifest: cell.writeCases === true,
    ledger,
  };
}

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
  const writeGuard = buildWriteGuard(cell, job.benchmarkRunId, args.ledger);
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
      source: "benchmark",
      ...(cell.environmentId ? { environmentId: cell.environmentId } : {}),
      ...(cell.namedHostId ? { namedHostId: cell.namedHostId } : {}),
      // The run's model calls are billed against the benchmark budget, and the
      // grant is what tells `/stream` which run to charge. Passed by reference:
      // the object is shared with the heartbeat, which rotates the grant inside
      // it when the backend reissues one.
      extraHeaders: args.grantHeaders,
      // Likewise by reference: the ledger inside is the RUN's, so what this
      // cell creates is what the run's cleanup removes.
      ...(writeGuard ? { benchmarkWriteGuard: writeGuard } : {}),
      idempotencyKey: evalChildIdempotencyKey(
        job.benchmarkRunId,
        args.entry.evidenceKey,
      ),
    });

    // A replayed claim replays the run its key already started. If that run
    // FINISHED, executing would run the exam a second time against someone
    // else's server and bill the budget twice for evidence the roster already
    // has.
    if (shouldSkipExecution(prepared)) {
      logger.info("[bench] cell already ran — not re-executing", {
        benchmarkRunId: job.benchmarkRunId,
        cellId: cell.cellId,
        runId: prepared.runId,
        status: prepared.status,
      });
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
 * The conformance child's idempotency key, namespaced.
 *
 * `externalRunId` is a single namespace shared with every other surface that
 * starts a conformance run (`api:<projectId>:<serverId>:<key>` is the /api/v1
 * shape), so a benchmark key that did not say it was one could collide with a
 * caller-supplied key and adopt somebody else's run.
 */
export function conformanceChildExternalRunId(
  benchmarkRunId: string,
  evidenceKey: string,
): string {
  return `benchmark:${evalChildIdempotencyKey(benchmarkRunId, evidenceKey)}`;
}

export type RunConformanceChildArgs = {
  job: ClaimedBenchmarkJob;
  entry: BenchmarkRosterEntry;
  spec: BenchmarkConformanceSpec;
};

/**
 * Run the pinned conformance suites as a persisted child.
 *
 * The OAuth suite is CONFIGURED here rather than excluded. `runConformance`
 * refuses a requested `oauth` suite with no auth strategy, and the executor
 * turns that into an explicit incomplete — so a definition that pins OAuth and
 * a worker that quietly drops it produce a scorecard whose OAuth section is
 * empty for a reason nobody recorded. The strategy is headless (or
 * client_credentials): the checks a consent screen would be needed for come
 * back `could_not_run`, which is the honest answer and the one the pinned
 * `headlessCheckIds` scope makes visible.
 */
async function defaultRunConformanceChild(
  args: RunConformanceChildArgs,
): Promise<{ runId: string }> {
  const { job, spec } = args;
  const oauth: OAuthConformanceConfig | undefined = spec.oauth
    ? {
        serverUrl: spec.serverUrl,
        protocolVersion: spec.oauth.protocolVersion,
        registrationStrategy: spec.oauth.registrationStrategy,
        auth: spec.oauth.auth,
        ...(spec.oauth.client ? { client: spec.oauth.client } : {}),
        ...(spec.oauth.scopes ? { scopes: spec.oauth.scopes } : {}),
        ...(spec.oauth.customHeaders
          ? { customHeaders: spec.oauth.customHeaders }
          : {}),
        ...(spec.oauth.redirectUrl
          ? { redirectUrl: spec.oauth.redirectUrl }
          : {}),
        // Verifying the server REJECTS bad input is half of OAuth conformance,
        // and these are the checks a headless run can actually reach.
        oauthConformanceChecks: true,
        // The suite dials URLs it DISCOVERS — authorization, token,
        // registration and metadata endpoints all come out of the target's own
        // documents — so the pinned endpoint is the one address that was ever
        // checkable up front. Every hop goes through the guarded transport.
        fetchFn: createConformanceFetch("OAuth endpoint"),
      }
    : undefined;

  const result = await executePersistedConformanceRun({
    convexToken: job.runnerBearer,
    projectId: job.projectId,
    server: { url: spec.serverUrl } as never,
    suites: spec.suites,
    source: "benchmark",
    target: {
      kind: "server",
      serverId: job.serverId,
      serverUrl: spec.serverUrl,
    },
    ...(spec.protocolVersion
      ? { protocolVersion: spec.protocolVersion }
      : {}),
    ...(spec.engineVersion ? { engineVersion: spec.engineVersion } : {}),
    ...(oauth ? { oauth } : {}),
    ...(spec.oauth?.headlessCheckIds?.length
      ? { oauthHeadlessCheckIds: spec.oauth.headlessCheckIds }
      : {}),
    actorLabel: `benchmark:${job.benchmarkRunId}`,
    externalRunId: conformanceChildExternalRunId(
      job.benchmarkRunId,
      args.entry.evidenceKey,
    ),
  });
  return { runId: result.runId };
}

export type RunAuthProbeArgs = {
  job: ClaimedBenchmarkJob;
  entry: BenchmarkRosterEntry;
  spec: BenchmarkProbeSpec;
};

export type CleanupArtifactsArgs = {
  job: ClaimedBenchmarkJob;
  ledger: BenchmarkArtifactLedger;
};

/**
 * Remove everything this run created on the target.
 *
 * Its OWN connection, opened after every cell has disconnected, because
 * cleanup outlives the cells: an artifact created by the first cell has to be
 * removable after the last one finished. No model is involved anywhere on this
 * path — a run that exhausted its budget still has to tidy up, and cleanup that
 * needed an LLM would be skipped by exactly the failure that most needs it.
 *
 * A connection we cannot open is `skipped`, not `clean`. The artifacts are
 * still there; saying otherwise would report an operator's server as tidy on
 * the strength of never having looked.
 */
async function defaultCleanupArtifacts(
  args: CleanupArtifactsArgs,
): Promise<ArtifactCleanupReport> {
  const pending = args.ledger.entries();
  if (pending.length === 0) {
    return {
      status: "clean",
      attempted: 0,
      removed: 0,
      residue: 0,
      residualIds: [],
    };
  }

  const { job } = args;
  const authorized = await createAuthorizedManager(
    {},
    job.runnerBearer,
    job.projectId,
    [job.serverId],
    WEB_CALL_TIMEOUT_MS,
    undefined,
    undefined,
    job.serverName ? { serverNames: [job.serverName] } : undefined,
  ).catch((error: unknown) => {
    logger.error("[bench] cleanup could not connect to the target", error, {
      benchmarkRunId: job.benchmarkRunId,
      residue: pending.length,
    });
    return null;
  });

  if (!authorized) {
    return {
      status: "skipped",
      attempted: pending.length,
      removed: 0,
      residue: pending.length,
      residualIds: pending.map((entry) => entry.createdId).slice(0, 50),
    };
  }

  try {
    return await cleanupBenchmarkArtifacts({
      ledger: args.ledger,
      callTool: ({ tool, args: toolArgs }) =>
        authorized.manager.executeTool(job.serverId, tool, toolArgs),
      onStepError: (error, context) => {
        logger.warn("[bench] cleanup step failed", {
          benchmarkRunId: job.benchmarkRunId,
          tool: context.tool,
          createdId: context.createdId,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
  } finally {
    await authorized.manager.disconnectAllServers().catch(() => {});
  }
}

/** Observe the target's unauthenticated behaviour from our own infrastructure. */
async function defaultRunAuthProbe(
  args: RunAuthProbeArgs,
): Promise<BenchmarkProbeEvidence> {
  // No `allowLoopback`: a scorecard about a server nobody else can reach is
  // not evidence, and the hosted guard refuses the address anyway.
  return runBenchmarkAuthProbe({ serverUrl: args.spec.serverUrl });
}

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
  runConformanceChild: typeof defaultRunConformanceChild;
  runAuthProbe: typeof defaultRunAuthProbe;
  cleanupArtifacts: typeof defaultCleanupArtifacts;
  attachEvidence: typeof attachEvalEvidence;
  attachConformance: typeof attachConformanceEvidence;
  attachProbe: typeof attachProbeEvidence;
  executionComplete: typeof reportExecutionComplete;
  finalize: typeof finalizeBenchmarkRun;
  analyze: typeof triggerFlowAnalyzer;
  complete: typeof completeBenchmarkJob;
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
    runConformanceChild: defaultRunConformanceChild,
    runAuthProbe: defaultRunAuthProbe,
    cleanupArtifacts: defaultCleanupArtifacts,
    attachEvidence: attachEvalEvidence,
    attachConformance: attachConformanceEvidence,
    attachProbe: attachProbeEvidence,
    executionComplete: reportExecutionComplete,
    finalize: finalizeBenchmarkRun,
    analyze: triggerFlowAnalyzer,
    complete: completeBenchmarkJob,
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

  /**
   * ONE ledger for the whole job, written by every write case and read by the
   * cleanup below. Per-run rather than per-cell because an artifact created by
   * the first cell has to be removable after the last one has finished.
   */
  const ledger = createBenchmarkArtifactLedger();
  let cleanupReport: ArtifactCleanupReport | undefined;

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

  /**
   * Remove what this run created, whatever ended it.
   *
   * NEVER THROWS, and reached by every path that got as far as launching a
   * cell: it dials the TARGET rather than the backend, so a lost lease does not
   * stop it — the ids are in THIS worker's ledger and no other worker can see
   * them. Budget exhaustion and cancellation reach it for the same reason.
   *
   * A claim refused before anything launched never gets here, and does not
   * need to: nothing was created.
   */
  const runCleanup = async (): Promise<void> => {
    try {
      cleanupReport = await deps.cleanupArtifacts({ job: claimed, ledger });
    } catch (error) {
      const pending = ledger.entries();
      logger.error("[bench] cleanup failed", error, {
        ...logContext,
        residue: pending.length,
      });
      cleanupReport = {
        status: "skipped",
        attempted: pending.length,
        removed: 0,
        residue: pending.length,
        residualIds: pending.map((entry) => entry.createdId).slice(0, 50),
      };
    }
    if (cleanupReport.residue > 0) {
      logger.warn("[bench] run left artifacts on the target", {
        ...logContext,
        status: cleanupReport.status,
        residue: cleanupReport.residue,
      });
    }
  };

  try {
    assertClaimExecutable(claimed);
    assertLeaseHeld();

    /**
     * Rostered rows of one kind that still owe a child.
     *
     * Terminal rows owe nothing. Launching one would pay a second time for
     * evidence the run already holds.
     */
    const owing = (kind: BenchmarkRosterEntry["kind"]) =>
      claimed.roster
        .filter(
          (entry) =>
            entry.kind === kind &&
            !TERMINAL_EVIDENCE_STATUSES.has(entry.status),
        )
        .sort((a, b) => (a.evidenceKey < b.evidenceKey ? -1 : 1));

    const cells = owing("eval_run").filter((entry) => entry.evalCell);

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
          ledger,
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
        await deps.attachEvidence({
          job: claimed,
          evidenceKey: entry.evidenceKey,
          cellId: cell.cellId,
          testSuiteRunId: runId,
        });
      } catch (error) {
        if (error instanceof LeaseLostError) throw error;
        logger.error("[bench] attaching cell evidence failed", error, {
          ...logContext,
          cellId: cell.cellId,
          runId,
        });
      }
    };

    /**
     * Run the auth-probe row: one bounded, unauthenticated observation made
     * from our own infrastructure.
     *
     * A probe that could not run is FILED, not suppressed. The payload says
     * `failed` or `refused` with a reason, and the backend records the row
     * unavailable — writing nothing would leave it `expected`, which reads as
     * a probe still to come rather than one that was refused.
     */
    const runAuthProbeRow = async (
      entry: BenchmarkRosterEntry,
    ): Promise<void> => {
      if (windDown.reason || leaseLost) return;
      const spec = entry.probeSpec;
      if (!spec?.serverUrl) {
        // Left `expected` for the backend's roster sweep to degrade into a
        // coverage gap. Not fatal to the job: losing one pillar is not a
        // reason to refuse the exam the payer bought.
        logger.error(
          "[bench] rostered auth probe carries no endpoint",
          new JobUnexecutableError(
            `rostered probe "${entry.evidenceKey}" carries no endpoint`,
          ),
          { ...logContext, evidenceKey: entry.evidenceKey },
        );
        return;
      }
      assertLeaseHeld();
      let evidence: BenchmarkProbeEvidence;
      try {
        evidence = await deps.runAuthProbe({ job: claimed, entry, spec });
      } catch (error) {
        if (error instanceof LeaseLostError) throw error;
        // The probe classifies every outcome it can into a payload, so a THROW
        // is a defect on our side. Filing it as a failed probe is still the
        // honest answer — what it must never become is a completed one.
        logger.error("[bench] auth probe threw", error, {
          ...logContext,
          evidenceKey: entry.evidenceKey,
        });
        evidence = {
          observedEndpoint: spec.serverUrl,
          discovery: { resourceMetadataFound: false },
          checks: [],
          status: "failed",
          failureReason:
            error instanceof Error ? error.message : String(error),
        };
      }
      assertLeaseHeld();
      try {
        await deps.attachProbe({
          job: claimed,
          evidenceKey: entry.evidenceKey,
          evidence,
        });
      } catch (error) {
        if (error instanceof LeaseLostError) throw error;
        logger.error("[bench] attaching probe evidence failed", error, {
          ...logContext,
          evidenceKey: entry.evidenceKey,
        });
      }
    };

    /** Run the pinned conformance suites and bind the persisted run. */
    const runConformanceRow = async (
      entry: BenchmarkRosterEntry,
    ): Promise<void> => {
      if (windDown.reason || leaseLost) return;
      const spec = entry.conformanceSpec;
      if (!spec?.serverUrl || !(spec.suites?.length > 0)) {
        logger.error(
          "[bench] rostered conformance child carries no launch spec",
          new JobUnexecutableError(
            `rostered conformance "${entry.evidenceKey}" carries no launch spec`,
          ),
          { ...logContext, evidenceKey: entry.evidenceKey },
        );
        return;
      }
      let runId: string | null = null;
      try {
        assertLeaseHeld();
        const result = await deps.runConformanceChild({
          job: claimed,
          entry,
          spec,
        });
        runId = result.runId;
      } catch (error) {
        if (error instanceof LeaseLostError) throw error;
        logger.error("[bench] conformance child could not be launched", error, {
          ...logContext,
          evidenceKey: entry.evidenceKey,
        });
      }
      if (!runId) return;
      assertLeaseHeld();
      try {
        await deps.attachConformance({
          job: claimed,
          evidenceKey: entry.evidenceKey,
          conformanceRunId: runId,
        });
      } catch (error) {
        if (error instanceof LeaseLostError) throw error;
        logger.error("[bench] attaching conformance evidence failed", error, {
          ...logContext,
          evidenceKey: entry.evidenceKey,
          runId,
        });
      }
    };

    /** Collect one child's failure without letting it abandon its siblings. */
    const settle = async (
      entry: BenchmarkRosterEntry,
      run: (entry: BenchmarkRosterEntry) => Promise<void>,
    ): Promise<void> => {
      try {
        await run(entry);
      } catch (error) {
        if (error instanceof LeaseLostError) {
          leaseLost ??= error;
          return;
        }
        logger.error("[bench] child aborted", error, {
          ...logContext,
          evidenceKey: entry.evidenceKey,
        });
      }
    };

    try {
      // The two non-model children first, and one at a time — see the module
      // header. They cost no credits, so a wind-down should never be what
      // throws them away; and running them concurrently would put two
      // unauthenticated conversations on a target that did not ask for either.
      for (const entry of owing("auth_probe")) {
        assertLeaseHeld();
        await settle(entry, runAuthProbeRow);
      }
      for (const entry of owing("conformance_run")) {
        assertLeaseHeld();
        await settle(entry, runConformanceRow);
      }

      assertLeaseHeld();

      const limit = createConcurrencyLimiter(MAX_CONCURRENT_READ_ONLY_CELLS);
      await Promise.all(
        readOnly.map((entry) => limit(() => settle(entry, runCell))),
      );

      assertLeaseHeld();

      // STRICTLY one at a time, and only after every read-only cell has
      // settled. A write case creates artifacts named for this run and then
      // asserts over what it can see; a sibling writing concurrently is
      // indistinguishable from the target leaking another tenant's data.
      for (const entry of writing) {
        assertLeaseHeld();
        await settle(entry, runCell);
      }
    } finally {
      // After every cell has disconnected, and before anything is reported:
      // the scorecard's cleanup status has to describe a cleanup that already
      // happened.
      await runCleanup();
    }

    assertLeaseHeld();
    await deps.executionComplete({
      job: claimed,
      claimedBy,
      ...(windDown.reason ? { stoppedReason: windDown.reason } : {}),
      ...(cleanupReport ? { cleanup: cleanupReport } : {}),
    });

    // Assemble the scorecard, then ask for the explanatory flow analysis, then
    // release the job — in that order and no other. The analyzer bills the
    // run's budget for an INFERRED artifact, so it must never be able to
    // change or delay a scorecard; and the lease has to outlive finalization
    // so a worker lost mid-assembly is swept rather than leaving a run parked
    // in `awaiting_evidence` with a complete roster.
    assertLeaseHeld();
    await deps.finalize({ job: claimed, claimedBy });

    assertLeaseHeld();
    await deps.analyze({ job: claimed, claimedBy }).catch((error) => {
      if (error instanceof LeaseLostError) throw error;
      logger.warn("[bench] flow analyzer could not be triggered", {
        ...logContext,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    assertLeaseHeld();
    await deps.complete({ job: claimed, claimedBy });
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
