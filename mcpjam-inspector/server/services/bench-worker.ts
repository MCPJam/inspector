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
 *      is not launched at all, and a child that DOES come back is adopted
 *      rather than driven — including a non-terminal one, which this process
 *      cannot distinguish from a live one another worker still owns.
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
 * And evidence that was produced is never traded for a tidy exit: the execution
 * phase is reported only once every piece of it has been bound to its row,
 * because a scorecard is inserted once and never patched.
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
  cleanupStepsFor,
  createBenchmarkArtifactLedger,
  type ArtifactLedgerEntry,
  type ArtifactCleanupReport,
  type BenchmarkArtifactLedger,
  type BenchmarkWriteGuard,
} from "./evals/artifact-ledger.js";
import {
  assertCaseMetadataPinned,
  CaseMetadataPinMismatchError,
  type CaseCleanupStep,
  type ResolvedCaseSideEffects,
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
 * How to launch one matrix cell.
 *
 * NOT a wire type. The backend's claim roster carries `cellId` and
 * `repetitions` and nothing else about how a cell runs, so this is ASSEMBLED
 * by {@link resolveEvalCellSpec} out of the roster row and the claim's pins —
 * and it is assembled strictly, because the fields it cannot fill are the ones
 * that decide which exam actually runs.
 */
export type BenchmarkEvalCell = {
  cellId: string;
  /** The exam the definition pins — `pins.suiteId` on the wire. */
  suiteId: string;
  /**
   * Project environment pinning the cell's model.
   *
   * The backend validates the child's `effectiveModelId` against the cell's
   * `requestedModel` when the evidence is attached, so a cell launched without
   * this runs an exam nobody asked for, spends the payer's credits on it, and
   * is then refused. There is no default worth guessing.
   */
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
 * Where the auth-probe child dials.
 *
 * NOT a wire type. The claim carries the endpoint exactly once, at
 * `target.serverUrl` — resolved backend-side from the saved server row,
 * because a worker holding a bearer scoped to one server has no way to look it
 * up. {@link resolveProbeSpec} reads it from there.
 */
export type BenchmarkProbeSpec = {
  serverUrl: string;
};

/**
 * How to run the conformance child.
 *
 * NOT a wire type; see {@link resolveConformanceSpec}.
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
 * MIRRORS `rosterFor()` in the backend's `benchmarkRuns.ts`. Everything here
 * is a field that route actually sends; the launch parameters a child needs
 * are NOT among them, which is what {@link resolveEvalCellSpec} exists to say
 * out loud.
 *
 * The roster is what makes resume possible: a partially executed matrix is
 * otherwise indistinguishable from a complete one, because in both cases the
 * only children that exist are the ones that ran.
 */
export type BenchmarkRosterEntry = {
  evidenceKey: string;
  /**
   * The child's idempotency key, DERIVED BACKEND-SIDE.
   *
   * Taken from the wire rather than recomputed here: two derivations of one
   * string are two chances to disagree by a character, and the character they
   * disagree by starts a second intrusive run against somebody else's server.
   */
  externalRunId?: string;
  pillar?: string;
  kind: string;
  status: string;
  required: boolean;
  cellId?: string;
  repetitions?: number;
  /** Backend-resolved project launch pins for this matrix cell. */
  environmentId?: string | null;
  namedHostId?: string | null;
  /**
   * The conformance suite scope this exam pins, on a `conformance_run` row.
   *
   * NOT SENT TODAY either — it lives in the definition's
   * `evidence.conformance.suites`, which the claim reduces to
   * `pins.definitionHash`. The endpoint is deliberately NOT part of it: that
   * comes from `target.serverUrl`, so there is exactly one statement of which
   * host is under measurement. See {@link resolveConformanceSpec}.
   */
  conformance?: Omit<BenchmarkConformanceSpec, "serverUrl">;
  /** The child already bound to this row, on a resume. */
  testSuiteRunId?: string | null;
  conformanceRunId?: string | null;
  readinessRunId?: string | null;
  probeRunId?: string | null;
  failureClass?: string;
};

/**
 * The claim payload, DECODED from the backend's claim httpAction — see
 * {@link decodeClaimedJob}. The two repos share no types, so the decoder is
 * the contract: unknown fields on the wire are ignored, and every field this
 * worker acts on is read from the exact place the backend puts it.
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
   * The lease generation this claim won. The backend reads it out of the GRANT
   * rather than the body, so this is for logging and for the heartbeat's own
   * bookkeeping — never for authorization.
   */
  leaseGeneration: number;
  leaseExpiresAt?: number;
  deadlineAt?: number;
  heartbeatIntervalMs?: number;
  attempt?: number;
  maxAttempts?: number;
  cancelRequested?: boolean;
  /** The hashes the CLAIM resolved, straight off `body.pins`. */
  pins: {
    definitionHash: string;
    consentHash?: string;
    caseMetadataHash?: string;
    matrixHash?: string;
    suiteId?: string;
    suiteRevision?: string;
    profileId?: string;
    profileVersion?: string;
    expectedEvidenceHash?: string;
    scoringPolicyHash?: string;
    taxonomyVersion?: string;
    caseMetadata?: unknown;
  };
  /** Straight off `body.target`. `serverUrl` is the endpoint the children dial. */
  target: {
    targetKind?: string;
    targetKey?: string;
    targetFingerprint?: string;
    benchmarkTargetId?: string;
    serverUrl?: string;
  };
  /** Straight off `body.consent`. What the payer agreed this run may do. */
  consent: { authenticatedChecks: boolean; writeCases: boolean };
  payerKind?: string;
  roster: BenchmarkRosterEntry[];
  /**
   * The execution grant (`purpose: 'benchmark-execution'`), from
   * `body.credentials.grant`. Sent on EVERY post-claim route in
   * `x-mcpjam-benchmark-grant` — the backend's `boundGrant()` reads the run,
   * the job and the lease generation out of it and refuses the write without
   * it — and forwarded verbatim to `/stream`. NEVER parsed here for
   * authorization: the worker is not the verifier, and a worker that reads
   * claims out of a token it merely carries is one refactor away from trusting
   * them.
   *
   * MUTATED IN PLACE when a heartbeat reissues one; see `executeClaimedJob`.
   */
  grant: string;
  /**
   * When the current grant expires, from `body.credentials.grantExpiresAt`.
   *
   * Sent back on every heartbeat, because that is what the backend compares
   * against `BENCHMARK_GRANT_REISSUE_BEFORE_S` to decide whether to mint a
   * replacement. Omitting it reads as `0`, which asks for a fresh grant on
   * every single beat and churns the `jti` a billing seam tells grants apart by.
   */
  grantExpiresAt?: number;
  /**
   * The benchmark-scoped bearer the children run as, from
   * `body.credentials.runnerBearer`. Scoped to this run's project + server
   * backend-side, so it is not an organization-wide credential even though it
   * is used like one here.
   */
  runnerBearer: string;
  runnerBearerExpiresAt?: number;
  /**
   * What this run has already created in the target's tenant, on a resume.
   *
   * `claimNextBenchmarkJob` returns this; the claim ROUTE does not currently
   * forward it. Decoded when present so a resumed worker inherits the previous
   * attempt's cleanup the day it does — see {@link hydrateArtifactLedger}.
   */
  artifacts?: unknown[];
};

/** What a heartbeat answers. Three of the four fields are stop signals. */
export type BenchmarkHeartbeat = {
  leaseOk: boolean;
  cancelRequested?: boolean;
  budgetStatus?: "active" | "exhausted" | "settled" | "none";
  runStatus?: string;
  leaseExpiresAt?: number;
  deadlineAt?: number;
  /**
   * A reissued grant, when the current one is close enough to expiry that a
   * long cell would outlive it.
   *
   * The backend spells this `credentials: { grant, grantExpiresAt }`, spread
   * alongside the beat rather than nested under a `result` — see the heartbeat
   * route. Adopted in place, into the job AND the shared header object, so
   * every post-claim write and every already-running child picks it up.
   */
  credentials?: { grant?: string; grantExpiresAt?: number };
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

/**
 * The vetted backend origin, or a throw naming the misconfiguration.
 *
 * ── WHY THE SCHEME IS CHECKED HERE AND NOT LEFT TO `fetch` ────────────────
 *
 * Every call below carries `x-inspector-service-token`, the credential that
 * authenticates this process AS the Inspector — it can claim jobs, heartbeat
 * them and abort them. Sending it to an `http:` host puts it on the wire in
 * cleartext for anyone on the path. Loopback is exempt because local dev
 * legitimately runs Convex over http on 127.0.0.1.
 *
 * `http:` is exempted ONLY for loopback: `ftp://localhost` is a
 * misconfiguration, and letting it reach `fetch` reports it as an unreachable
 * upstream instead of the config error it is.
 *
 * This is the same policy `callBackend` applies in `routes/web/bench.ts`.
 * Restated rather than imported: that helper is an HTTP-route collaborator —
 * it throws `WebRouteError`, collapses 404 into a feature-disabled verdict and
 * never surfaces the raw status — and this worker branches on the raw status
 * of every route it calls. Sharing the transport would mean weakening one of
 * the two; sharing the POLICY is what actually matters, so it is written out
 * with the same exemptions and locked by its own test.
 */
function benchServiceConfig(): { convexUrl: string; serviceToken: string } {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  const serviceToken = process.env.INSPECTOR_SERVICE_TOKEN;
  if (!convexUrl || !serviceToken) {
    throw new Error(
      "Bench worker requires CONVEX_HTTP_URL and INSPECTOR_SERVICE_TOKEN",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(convexUrl);
  } catch {
    throw new Error("Bench worker: CONVEX_HTTP_URL is not a valid URL");
  }
  const isLoopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "::1" ||
    parsed.hostname === "[::1]";
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && isLoopback)
  ) {
    throw new Error(
      "Bench worker: refusing to send the inspector service token to a " +
        `non-HTTPS CONVEX_HTTP_URL (${parsed.protocol}//${parsed.hostname})`,
    );
  }
  return { convexUrl: convexUrl.replace(/\/$/, ""), serviceToken };
}

/**
 * EVERY `/internal/v1/bench/*` path this worker calls, spelled once.
 *
 * The worker family the backend's `registerBenchmarkJobRoutes` publishes, and
 * the only reason it is a table rather than template literals at each call
 * site: a path typo is a 404, a 404 on this surface reads as "the feature is
 * switched off here", and the loop then parks on a slow poll forever instead
 * of reporting anything. `bench-worker-routes.test.ts` locks this table
 * against the backend's registration list.
 */
export const BENCH_SERVICE_ROUTES = {
  claim: `${BENCH_SERVICE_BASE}/jobs/claim`,
  heartbeat: `${BENCH_SERVICE_BASE}/jobs/heartbeat`,
  complete: `${BENCH_SERVICE_BASE}/jobs/complete`,
  abort: `${BENCH_SERVICE_BASE}/jobs/abort`,
  evidenceAttach: `${BENCH_SERVICE_BASE}/evidence/attach`,
  evidenceUnobtainable: `${BENCH_SERVICE_BASE}/evidence/unobtainable`,
  evidenceClaimChild: `${BENCH_SERVICE_BASE}/evidence/claim-child`,
  evidenceProbe: `${BENCH_SERVICE_BASE}/evidence/probe`,
  artifacts: `${BENCH_SERVICE_BASE}/artifacts`,
  roster: `${BENCH_SERVICE_BASE}/runs/roster`,
  finalize: `${BENCH_SERVICE_BASE}/runs/finalize`,
  /**
   * `/runs/`, not `/jobs/`. The job stays leased across this call — it is the
   * RUN that moves to `awaiting_evidence` — and the backend registers it with
   * the other run-scoped routes accordingly.
   */
  executionComplete: `${BENCH_SERVICE_BASE}/runs/execution-complete`,
} as const;

type ServiceRouteResponse = { status: number; body: any };

/**
 * One POST at a `/internal/v1/bench/*` worker route.
 *
 * ── TWO CREDENTIALS, NOT ONE ──────────────────────────────────────────────
 *
 * The service token says this process is the Inspector. It is NOT permission
 * to write to a particular run: every post-claim route calls `boundGrant()`
 * and reads the run, the job and the lease generation out of
 * `x-mcpjam-benchmark-grant`, answering 401 when the header is missing. So the
 * grant is threaded through explicitly — a route that needs one and is called
 * without one fails the same way a route called with a stale one does, which
 * is exactly the confusion worth making impossible.
 *
 * `/jobs/claim` is the one route with no grant to send: it is the route that
 * MINTS the grant.
 */
async function postServiceRoute(
  path: string,
  body: Record<string, unknown>,
  options?: { grant?: string },
): Promise<ServiceRouteResponse> {
  const env = benchServiceConfig();
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
        ...(options?.grant
          ? { [BENCHMARK_GRANT_HEADER]: options.grant }
          : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      // The scheme check above vets the CONFIGURED host and nothing else.
      // `fetch` follows redirects by default and replays request headers to
      // wherever it lands, so a 3xx from a compromised or merely misconfigured
      // deployment would hand the service token AND the execution grant to
      // another origin — over http, even. Refuse to follow; the credentials
      // stay confined to the host we vetted.
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error(
        `bench route ${path} redirected (${response.status}); refusing to forward the service token`,
      );
    }
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

/** A trimmed, non-empty string, or `null`. Same rule the backend reads by. */
function readString(source: any, key: string): string | null {
  const value = source?.[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readNumber(source: any, key: string): number | undefined {
  const value = source?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Turn the claim response into a job, or explain why it is not one.
 *
 * ── WHY THIS IS A DECODER AND NOT A CAST ──────────────────────────────────
 *
 * The backend answers `{ ok, claimed: true, job, pins, target, consent,
 * payerKind, roster, credentials }` — `claimed` is the literal boolean, and
 * everything the worker needs is a SIBLING of it. Casting `body.claimed` into
 * this type produces `true`, whose every property is `undefined`: no job id,
 * no grant, no bearer, no roster. Nothing downstream can tell that apart from
 * a backend that answered badly, so it is read field by field here, from the
 * exact place the route puts each one, and refused loudly when a required one
 * is missing.
 *
 * Unknown fields are ignored rather than rejected — adding one backend-side
 * must not stop this worker claiming.
 */
export function decodeClaimedJob(body: any): ClaimedBenchmarkJob | null {
  if (body?.claimed !== true) return null;
  const job = body.job ?? {};
  const credentials = body.credentials ?? {};
  const pins = body.pins ?? {};
  const consent = body.consent ?? {};

  const jobId = readString(job, "jobId");
  const benchmarkRunId = readString(job, "benchmarkRunId");
  const grant = readString(credentials, "grant");
  const runnerBearer = readString(credentials, "runnerBearer");
  // Named individually: "the claim was missing something" is not a diagnosis,
  // and this message becomes the abort reason an operator reads.
  const missing = [
    jobId ? null : "job.jobId",
    benchmarkRunId ? null : "job.benchmarkRunId",
    readString(job, "projectId") ? null : "job.projectId",
    readString(job, "serverId") ? null : "job.serverId",
    grant ? null : "credentials.grant",
    runnerBearer ? null : "credentials.runnerBearer",
    readString(pins, "definitionHash") ? null : "pins.definitionHash",
  ].filter((field): field is string => field !== null);
  if (missing.length > 0) {
    throw new JobUnexecutableError(
      `the claim response is missing ${missing.join(", ")}`,
    );
  }

  return {
    jobId: jobId as string,
    benchmarkRunId: benchmarkRunId as string,
    organizationId: readString(job, "organizationId") ?? "",
    projectId: readString(job, "projectId") as string,
    serverId: readString(job, "serverId") as string,
    leaseGeneration: readNumber(job, "leaseGeneration") ?? 0,
    ...(readNumber(job, "leaseExpiresAt") !== undefined
      ? { leaseExpiresAt: readNumber(job, "leaseExpiresAt") }
      : {}),
    ...(readNumber(job, "deadlineAt") !== undefined
      ? { deadlineAt: readNumber(job, "deadlineAt") }
      : {}),
    ...(readNumber(job, "heartbeatIntervalMs") !== undefined
      ? { heartbeatIntervalMs: readNumber(job, "heartbeatIntervalMs") }
      : {}),
    ...(readNumber(job, "attempt") !== undefined
      ? { attempt: readNumber(job, "attempt") }
      : {}),
    ...(readNumber(job, "maxAttempts") !== undefined
      ? { maxAttempts: readNumber(job, "maxAttempts") }
      : {}),
    cancelRequested: job.cancelRequested === true,
    pins: {
      ...(typeof pins === "object" && pins !== null ? pins : {}),
      definitionHash: readString(pins, "definitionHash") as string,
    },
    target:
      typeof body.target === "object" && body.target !== null
        ? body.target
        : {},
    // Both default to FALSE, never to "the field was absent so assume yes".
    // These two booleans are the whole of what the payer agreed to; an absent
    // one is a backend that did not say, and "did not say" is not consent.
    consent: {
      authenticatedChecks: consent.authenticatedChecks === true,
      writeCases: consent.writeCases === true,
    },
    ...(readString(body, "payerKind")
      ? { payerKind: readString(body, "payerKind") as string }
      : {}),
    roster: Array.isArray(body.roster)
      ? body.roster.filter(
          (entry: any) => typeof entry === "object" && entry !== null,
        )
      : [],
    grant: grant as string,
    ...(readNumber(credentials, "grantExpiresAt") !== undefined
      ? { grantExpiresAt: readNumber(credentials, "grantExpiresAt") }
      : {}),
    runnerBearer: runnerBearer as string,
    ...(readNumber(credentials, "runnerBearerExpiresAt") !== undefined
      ? { runnerBearerExpiresAt: readNumber(credentials, "runnerBearerExpiresAt") }
      : {}),
    ...(Array.isArray(body.artifacts) ? { artifacts: body.artifacts } : {}),
  };
}

async function claimNext(
  claimedBy: string,
): Promise<ClaimedBenchmarkJob | null | "disabled"> {
  const { status, body } = await postServiceRoute(BENCH_SERVICE_ROUTES.claim, {
    claimedBy,
  });
  if (isFeatureDisabled(status, body)) return "disabled";
  if (status !== 200 || !body?.ok) {
    throw new Error(`claim failed (${status})`);
  }
  return decodeClaimedJob(body);
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
    BENCH_SERVICE_ROUTES.heartbeat,
    {
      benchmarkRunId: job.benchmarkRunId,
      claimedBy,
      // What the backend compares against its reissue window. Sent from the
      // job so a grant already rotated once is not re-requested every beat.
      ...(job.grantExpiresAt !== undefined
        ? { grantExpiresAt: job.grantExpiresAt }
        : {}),
    },
    { grant: job.grant },
  );
  if (isLeaseLostResponse(status, body)) {
    throw new LeaseLostError("heartbeat rejected the lease generation");
  }
  if (status !== 200 || !body?.ok) {
    throw new Error(`heartbeat rejected (${status})`);
  }
  // The beat is spread into the envelope alongside `ok` — there is no `result`
  // wrapper — and a reissued grant arrives under `credentials`.
  return body as BenchmarkHeartbeat;
}

/**
 * Bind a child run to its rostered evidence row.
 *
 * Called for a child that FAILED as well as one that passed: the row carries
 * the pointer, and the backend derives the terminal status from the child
 * itself. An unattached failure is invisible until a sweep notices it, which
 * turns a known failure into a coverage gap.
 *
 * ── THE PAYLOAD IS DISCRIMINATED ON `kind` ────────────────────────────────
 *
 * `parseEvidenceAttachment` switches on `kind` and reads only that variant's
 * fields. An eval child is `{ kind: 'eval_cell', cellId, suiteRunId }` — the
 * id field is `suiteRunId`, `evidenceKey` belongs to the `readiness` variant
 * alone, and a payload with neither discriminator is answered 400 with
 * `"kind" must be conformance, readiness, eval_cell or auth_probe`. The row is
 * found from the CELL (`eval:{cellId}`), not from an evidence key we send.
 */
async function attachEvalEvidence(args: {
  job: ClaimedBenchmarkJob;
  evidenceKey: string;
  cellId: string;
  testSuiteRunId: string;
}): Promise<void> {
  const { status, body } = await postServiceRoute(
    BENCH_SERVICE_ROUTES.evidenceAttach,
    {
      // Compared against the grant's claims rather than trusted: a worker
      // writing to a run it does not think it is writing to has a bug, and the
      // backend answers 409 rather than hiding it.
      benchmarkRunId: args.job.benchmarkRunId,
      kind: "eval_cell",
      cellId: args.cellId,
      suiteRunId: args.testSuiteRunId,
    },
    { grant: args.job.grant },
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
    BENCH_SERVICE_ROUTES.evidenceAttach,
    {
      benchmarkRunId: args.job.benchmarkRunId,
      // WITHOUT THIS the payload has no discriminator at all and
      // `parseEvidenceAttachment` answers 400 — the run then sits in the
      // unattached/retry path with a conformance child that really ran.
      kind: "conformance",
      conformanceRunId: args.conformanceRunId,
    },
    { grant: args.job.grant },
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
    BENCH_SERVICE_ROUTES.evidenceProbe,
    {
      benchmarkRunId: args.job.benchmarkRunId,
      // The route reads `status`, `checks`, `observedEndpoint`, `discovery`,
      // `nonCompliantChallengeStatus`, `registrationStrategies` and
      // `failureReason` off the body — which is exactly this shape.
      ...args.evidence,
    },
    { grant: args.job.grant },
  );
  if (isLeaseLostResponse(status, body)) {
    throw new LeaseLostError("probe attach rejected the lease generation");
  }
  if (status !== 200 || !body?.ok) {
    throw new Error(`probe evidence attach rejected (${status})`);
  }
}

/**
 * Write what a write case just created into the RUN's durable ledger.
 *
 * ── WHY THIS EXISTS AT ALL ────────────────────────────────────────────────
 *
 * The in-process ledger dies with the process, and what dies with it is the
 * list of rows this benchmark just created in a third party's account.
 * Cleanup being idempotent and retried is worth nothing once the list of what
 * to clean is gone — and a resumed worker that starts from an empty ledger
 * reports a clean run over artifacts that are still there.
 *
 * Idempotent backend-side on `(run, tool, createdId)`, so a retried batch does
 * not double-count the residue figure this table exists to produce.
 */
async function recordArtifacts(args: {
  job: ClaimedBenchmarkJob;
  artifacts: ReadonlyArray<{
    caseId: string;
    tool: string;
    createdId: string;
    evidenceKey?: string;
    iteration?: number;
    artifactName?: string;
  }>;
}): Promise<void> {
  if (args.artifacts.length === 0) return;
  const { status, body } = await postServiceRoute(
    BENCH_SERVICE_ROUTES.artifacts,
    {
      benchmarkRunId: args.job.benchmarkRunId,
      artifacts: args.artifacts,
    },
    { grant: args.job.grant },
  );
  if (isLeaseLostResponse(status, body)) {
    throw new LeaseLostError("artifact record rejected the lease generation");
  }
  if (status !== 200 || !body?.ok) {
    throw new Error(`artifact record rejected (${status})`);
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
    BENCH_SERVICE_ROUTES.executionComplete,
    {
      benchmarkRunId: args.job.benchmarkRunId,
      claimedBy: args.claimedBy,
      ...(args.stoppedReason ? { stoppedReason: args.stoppedReason } : {}),
      ...(args.cleanup ? { cleanup: args.cleanup } : {}),
    },
    { grant: args.job.grant },
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
    BENCH_SERVICE_ROUTES.abort,
    {
      benchmarkRunId: args.job.benchmarkRunId,
      claimedBy: args.claimedBy,
      // `failureMessage`, not `reason`: the abort mutation reads the former
      // and drops anything else, so a run aborted under the wrong key ends
      // with no explanation at all.
      failureMessage: args.reason.slice(0, 500),
      retryable: args.retryable,
    },
    { grant: args.job.grant },
  );
  if (status !== 200 || !body?.ok) {
    logger.warn("[bench] abort rejected", {
      jobId: args.job.jobId,
      status,
    });
  }
}

/**
 * Assemble the launch spec for one rostered eval cell, or refuse the claim.
 *
 * ── WHAT THE BACKEND ACTUALLY SENDS, AND WHAT IT DOES NOT ─────────────────
 *
 * A claim roster row (`rosterFor` in `benchmarkRuns.ts`) carries
 * `evidenceKey`, `externalRunId`, `pillar`, `kind`, `required`, `status`,
 * `cellId`, `repetitions` and whatever child id it has already been bound to.
 * The pins carry `suiteId` and `suiteRevision`. So the exam and the cell and
 * the repetition count ARE resolvable, and they are resolved here.
 *
 * The backend resolves the portable matrix labels to a project-owned host at
 * claim time. A missing pin is still refused before any connection or model
 * call, because falling back to a suite default can spend the payer's credits
 * on evidence that the backend will reject for the wrong engine or model.
 */
export function resolveEvalCellSpec(
  job: ClaimedBenchmarkJob,
  entry: BenchmarkRosterEntry,
): BenchmarkEvalCell {
  const cellId = typeof entry.cellId === "string" ? entry.cellId.trim() : "";
  const suiteId =
    typeof job.pins?.suiteId === "string" ? job.pins.suiteId.trim() : "";
  // Absent is refused rather than defaulted so a stale or malformed claim
  // cannot silently change the cell it is charging.
  const environmentId =
    typeof entry.environmentId === "string" && entry.environmentId.length > 0
      ? entry.environmentId
      : null;
  const namedHostId =
    typeof entry.namedHostId === "string" && entry.namedHostId.length > 0
      ? entry.namedHostId
      : null;

  const missing = [
    cellId ? null : "cellId (roster row)",
    suiteId ? null : "suiteId (claim pins)",
    environmentId || namedHostId
      ? null
      : "environmentId/namedHostId (the cell's pinned model and client profile)",
  ].filter((field): field is string => field !== null);
  if (missing.length > 0) {
    throw new JobUnexecutableError(
      `rostered cell "${entry.evidenceKey}" cannot be launched: the claim carries no ${missing.join(", no ")}`,
    );
  }

  const caseSideEffects = pinnedCaseSideEffects(job);
  const declaresWrite = caseSideEffects.some(
    (entry) => entry.sideEffects.mode === "test_write",
  );

  return {
    cellId,
    suiteId,
    environmentId,
    namedHostId,
    // ── EITHER SOURCE MAKES A CELL A WRITE CELL ───────────────────────────
    //
    // The pinned `caseMetadata` says whether the EXAM contains a write case;
    // `consent.writeCases` says whether the payer agreed this run may write at
    // all. Neither is a per-cell fact — the metadata is keyed by case, and the
    // consent by run — so the honest answer for a cell is "read-only only when
    // BOTH say so". Anything else stays serial; see `writeCases`.
    writeCases: declaresWrite || job.consent?.writeCases === true,
    ...(caseSideEffects.length > 0 ? { caseSideEffects } : {}),
  };
}

/**
 * The pinned per-case manifests, flattened out of `pins.caseMetadata`.
 *
 * The backend sends that section WHOLE — `{ suiteHash, cases: [{ caseId,
 * sideEffects, … }] }` — precisely so the worker does not slice it per cell:
 * "a derivation done here and re-derived by the worker is two chances to
 * disagree about which case may write what". Every case of the pinned exam is
 * therefore carried by every cell of it, and the `caseMetadataHash` stamp that
 * ties the manifest to the definition is attached here so
 * `assertCaseMetadataPinned` has something to check.
 */
function pinnedCaseSideEffects(
  job: ClaimedBenchmarkJob,
): PinnedCaseSideEffects[] {
  const section = job.pins?.caseMetadata as
    | { suiteHash?: unknown; cases?: unknown }
    | undefined;
  if (!section || !Array.isArray(section.cases)) return [];
  const suiteHash =
    typeof section.suiteHash === "string" ? section.suiteHash : "";
  const caseMetadataHash =
    typeof job.pins?.caseMetadataHash === "string"
      ? job.pins.caseMetadataHash
      : "";
  const resolved: PinnedCaseSideEffects[] = [];
  for (const entry of section.cases) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as { caseId?: unknown; sideEffects?: unknown };
    const sideEffects = row.sideEffects as ResolvedCaseSideEffects | undefined;
    if (typeof row.caseId !== "string" || !sideEffects?.mode) continue;
    resolved.push({
      suiteHash,
      caseId: row.caseId,
      caseMetadataHash,
      sideEffects,
    });
  }
  return resolved;
}

/**
 * Where the auth probe dials, from the one place the claim names it.
 *
 * `target.serverUrl` is resolved backend-side from the saved server row and is
 * the ONLY endpoint on the wire — there is no `probeSpec` on a roster row. A
 * claim that carries no endpoint at all cannot be probed, and refusing says so
 * rather than leaving the row `expected` for a sweep to reinterpret.
 */
export function resolveProbeSpec(
  job: ClaimedBenchmarkJob,
  entry: BenchmarkRosterEntry,
): BenchmarkProbeSpec {
  const serverUrl =
    typeof job.target?.serverUrl === "string" ? job.target.serverUrl.trim() : "";
  if (!serverUrl) {
    throw new JobUnexecutableError(
      `rostered probe "${entry.evidenceKey}" cannot be run: the claim carries no target.serverUrl`,
    );
  }
  return { serverUrl };
}

/**
 * How to run the conformance child — and why this one cannot be assembled.
 *
 * The endpoint comes from `target.serverUrl`, same as the probe. The SUITES do
 * not: which conformance suites an exam grades lives in the definition's
 * `evidence.conformance.suites`, it is part of the hashed manifest, and the
 * claim reduces the whole definition to `pins.definitionHash`. Nothing on the
 * wire names them.
 *
 * Guessing is not available. The suites in scope ARE the denominator a
 * conformance section is scored against, so running a set we picked would
 * report a percentage of a different exam under this profile's name — and it
 * would do it after dialling a third party's server.
 *
 * So the claim is refused, by name. Closing this is a backend change: put the
 * pinned suite scope on the conformance roster row.
 */
export function resolveConformanceSpec(
  job: ClaimedBenchmarkJob,
  entry: BenchmarkRosterEntry,
): BenchmarkConformanceSpec {
  const serverUrl =
    typeof job.target?.serverUrl === "string" ? job.target.serverUrl.trim() : "";
  // Forward-compatible, exactly like the cell's launch pins: read where the
  // backend would naturally put it, refuse when it is not there.
  const scope = entry.conformance;
  const suites = Array.isArray(scope?.suites) ? scope.suites : [];
  const missing = [
    serverUrl ? null : "target.serverUrl",
    suites.length > 0 ? null : "the pinned conformance suite scope",
  ].filter((field): field is string => field !== null);
  if (missing.length > 0) {
    throw new JobUnexecutableError(
      `rostered conformance "${entry.evidenceKey}" cannot be run: the claim carries no ${missing.join(", no ")}`,
    );
  }
  // The endpoint always comes from the target, never from the scope: there is
  // one server under measurement, and a second copy of its URL is a second
  // chance to grade the wrong host.
  return { ...scope, suites, serverUrl };
}

/**
 * Everything the claim has to satisfy before a single child is launched.
 *
 * ── THE DEFINITION HASH IS CHECKED BACKEND-SIDE, NOT HERE ─────────────────
 *
 * This function used to compare a job-level `definitionHash` against
 * `pins.definitionHash` to catch a definition republished between admission
 * and execution. The claim response carries ONE hash — `pins.definitionHash`,
 * taken from `run.definitionHash` — so the comparison was between a field and
 * itself, or between a field and `undefined`. The check it was reaching for
 * genuinely lives in the backend: `loadDefinition` re-hashes the stored
 * manifest on read and refuses on mismatch, and `claimNextBenchmarkJob` fails
 * the job `DEFINITION_UNRESOLVABLE` rather than handing it out. What is left
 * to assert here is that the pin arrived at all — a claim with no pinned
 * definition hash names no exam.
 *
 * Every rostered row this worker owns must resolve to a launch spec BEFORE
 * anything runs, so a gap ends the job with one reason rather than surfacing
 * as a matrix that quietly ran nothing.
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
  if (!job.benchmarkRunId) {
    throw new JobUnexecutableError("the claim carried no benchmark run id");
  }
  if (!job.pins?.definitionHash) {
    throw new JobUnexecutableError("the claim carried no pinned definition hash");
  }
  for (const entry of job.roster ?? []) {
    // A row that already reached a terminal status owes no child, so it needs
    // no launch spec — refusing the whole job over a cell that already ran
    // would strand a run that is nearly finished.
    if (TERMINAL_EVIDENCE_STATUSES.has(entry.status)) continue;
    // EVERY lane, not just the matrix. A pillar whose spec cannot be resolved
    // was previously logged and skipped, which leaves the row `expected` and
    // reports a complete execution phase over a pillar that never ran — the
    // scorecard is inserted once, so the gap is permanent and invisible.
    if (entry.kind === "auth_probe") {
      resolveProbeSpec(job, entry);
      continue;
    }
    if (entry.kind === "conformance_run") {
      resolveConformanceSpec(job, entry);
      continue;
    }
    if (entry.kind !== "eval_run") continue;
    const cell = resolveEvalCellSpec(job, entry);
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
        // `pins.suiteRevision` IS the canonical suite content hash — the
        // backend pins sha256(suite.configRevision) under both legacy names
        // (`suiteRevision` and the manifest's `suiteHash`), and its resolver
        // refuses a definition where they diverge. So forwarding the
        // revision as the expected suite hash is exact, not a coincidence;
        // see ResolvedAgentEvalPolicy in mcpjam-backend
        // convex/lib/benchmarkDefinition.ts.
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
      // Likewise by reference: the ledger inside is the RUN's, so what this
      // cell creates is what the run's cleanup removes.
      ...(writeGuard ? { benchmarkWriteGuard: writeGuard } : {}),
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

/**
 * The artifacts a previous attempt already created, read back off the claim.
 *
 * ── A HONEST NOTE ABOUT WHERE THIS COMES FROM ─────────────────────────────
 *
 * `claimNextBenchmarkJob` computes an artifact ledger and returns it, but the
 * claim ROUTE does not currently forward it — the response is assembled field
 * by field and `artifacts` is not among them. So on today's backend this
 * hydrates nothing, and the durable half (write-through, above) is what
 * actually protects a resumed run: the ids are in `benchmarkRunArtifacts`
 * whether or not this worker can read them back. Read defensively from where
 * the mutation already puts it, so the day the route forwards the field a
 * resumed worker inherits the previous attempt's cleanup with no further
 * change here.
 *
 * The cleanup STEPS are not on the wire either — the backend's row is
 * `{ artifactId, caseId, tool, createdId, status, … }` — so they are
 * re-derived from the pinned `caseMetadata` by `caseId`. That is the same
 * manifest the create was licensed under, which is the only thing that could
 * legitimately say how to remove it.
 */
export function hydrateArtifactLedger(
  job: ClaimedBenchmarkJob,
): Array<Omit<ArtifactLedgerEntry, "createdAt">> {
  const rows = Array.isArray(job.artifacts) ? job.artifacts : [];
  if (rows.length === 0) return [];
  const stepsByCaseId = new Map<string, CaseCleanupStep[]>();
  for (const pinned of pinnedCaseSideEffects(job)) {
    stepsByCaseId.set(pinned.caseId, cleanupStepsFor(pinned.sideEffects));
  }
  const hydrated: Array<Omit<ArtifactLedgerEntry, "createdAt">> = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const entry = row as Record<string, unknown>;
    // A row the backend already marked removed is not residue this run still
    // owes; re-deleting it would be a second call against the target for
    // nothing.
    if (entry.status === "removed") continue;
    const createdId =
      typeof entry.createdId === "string" ? entry.createdId : "";
    const tool = typeof entry.tool === "string" ? entry.tool : "";
    if (!createdId || !tool) continue;
    const caseId = typeof entry.caseId === "string" ? entry.caseId : undefined;
    hydrated.push({
      tool,
      artifactName:
        typeof entry.artifactName === "string" ? entry.artifactName : "",
      createdId,
      cleanupSteps: (caseId ? stepsByCaseId.get(caseId) : undefined) ?? [],
      ...(caseId ? { caseId } : {}),
      ...(typeof entry.iteration === "number"
        ? { iteration: entry.iteration }
        : {}),
    });
  }
  return hydrated;
}

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
 * Test seam: the heartbeat is the one route that both SENDS the grant and
 * receives a replacement for it, so its wire shape is the contract.
 */
export const sendHeartbeatForTests = sendHeartbeat;

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
  /** The durable half of the artifact ledger; see `recordArtifacts`. */
  recordArtifacts: typeof recordArtifacts;
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
    recordArtifacts,
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
   *
   * HYDRATED from the claim and WRITTEN THROUGH to the backend. A worker that
   * dies after a create call, or loses its lease before cleanup, would
   * otherwise take the ids with it and the resumed worker would report a clean
   * empty ledger while the artifacts stayed in the target's tenant.
   */
  const ledger = createBenchmarkArtifactLedger({
    initial: hydrateArtifactLedger(claimed),
    persist: (entries) =>
      deps.recordArtifacts({
        job: claimed,
        artifacts: entries.map((entry) => ({
          // `caseId`, `tool` and `createdId` are the three the backend
          // requires; a row missing any of them is refused outright.
          caseId: entry.caseId ?? "unknown",
          tool: entry.tool,
          createdId: entry.createdId,
          ...(entry.artifactName ? { artifactName: entry.artifactName } : {}),
          ...(entry.iteration !== undefined
            ? { iteration: entry.iteration }
            : {}),
        })),
      }),
  });
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
        // ROTATION LANDS IN BOTH PLACES, because two different consumers read
        // the grant: `claimed.grant` is what every post-claim write sends in
        // `x-mcpjam-benchmark-grant`, and `grantHeaders` is the object the eval
        // engine re-reads per step, so writing it there reaches children that
        // are ALREADY running. Updating one and not the other would leave half
        // the job authenticating with a grant that has expired.
        const reissued = result?.credentials?.grant;
        if (reissued) {
          claimed.grant = reissued;
          claimed.grantExpiresAt = result.credentials?.grantExpiresAt;
          grantHeaders[BENCHMARK_GRANT_HEADER] = reissued;
        }
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
    const owing = (kind: string) =>
      claimed.roster
        .filter(
          (entry) =>
            entry.kind === kind &&
            !TERMINAL_EVIDENCE_STATUSES.has(entry.status),
        )
        .sort((a, b) => (a.evidenceKey < b.evidenceKey ? -1 : 1));

    // Resolved UP FRONT, and never filtered on success. A row that cannot be
    // launched has already thrown out of `assertClaimExecutable` above; a row
    // dropped here instead would be a rostered cell the run silently never
    // ran, which is the one outcome that must not be possible.
    const cells: Array<{ entry: BenchmarkRosterEntry; cell: BenchmarkEvalCell }> =
      owing("eval_run").map((entry) => ({
        entry,
        cell: resolveEvalCellSpec(claimed, entry),
      }));

    // READ-ONLY FIRST, deliberately. A cancellation or an exhausted budget
    // stops launching wherever it lands, and the cells worth losing to that are
    // the ones that would have written to somebody else's server.
    //
    // Read-only is the EXPLICIT `false`, never the absence — see `writeCases`.
    const readOnly = cells.filter((item) => item.cell.writeCases === false);
    const writing = cells.filter((item) => item.cell.writeCases !== false);

    /**
     * Evidence that was PRODUCED and could not be bound to its row:
     * evidenceKey → what was lost. Non-empty means the execution phase must NOT
     * be reported.
     *
     * Every lane writes into it, not just the eval matrix. A conformance run
     * that dialled the target and a probe that observed it are as unrecoverable
     * as a cell once the scorecard is inserted.
     */
    const unattached = new Map<string, string>();

    /**
     * Bind evidence to its row, retrying a transient refusal.
     *
     * A lost lease is never retried — the write would be refused every time,
     * and the whole point of standing down is to stop writing.
     */
    const attachWithRetry = async (
      context: Record<string, unknown>,
      attach: () => Promise<void>,
    ): Promise<void> => {
      for (let attempt = 0; ; attempt++) {
        try {
          await attach();
          return;
        } catch (error) {
          if (error instanceof LeaseLostError) throw error;
          if (attempt >= ATTACH_RETRY_DELAYS_MS.length) throw error;
          logger.warn("[bench] evidence attach failed; retrying", {
            ...logContext,
            ...context,
            attempt: attempt + 1,
            error: error instanceof Error ? error.message : String(error),
          });
          await sleep(ATTACH_RETRY_DELAYS_MS[attempt]);
          assertLeaseHeld();
        }
      }
    };

    const runCell = async (item: {
      entry: BenchmarkRosterEntry;
      cell: BenchmarkEvalCell;
    }): Promise<void> => {
      if (windDown.reason || leaseLost) return;
      const { entry, cell } = item;
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
        await attachWithRetry({ cellId: cell.cellId, runId }, () =>
          deps.attachEvidence({
            job: claimed,
            evidenceKey: entry.evidenceKey,
            cellId: cell.cellId,
            testSuiteRunId: runId,
          }),
        );
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

    /**
     * Run the auth-probe row: one bounded, unauthenticated observation made
     * from our own infrastructure.
     *
     * A probe that could not run is FILED, not suppressed. The payload says
     * `failed` or `refused` with a reason, and the backend records the row
     * unavailable — writing nothing would leave it `expected`, which reads as
     * a probe still to come rather than one that was refused.
     */
    const runAuthProbeRow = async (item: {
      entry: BenchmarkRosterEntry;
      spec: BenchmarkProbeSpec;
    }): Promise<void> => {
      if (windDown.reason || leaseLost) return;
      const { entry, spec } = item;
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
        await attachWithRetry({ evidenceKey: entry.evidenceKey }, () =>
          deps.attachProbe({
            job: claimed,
            evidenceKey: entry.evidenceKey,
            evidence,
          }),
        );
      } catch (error) {
        if (error instanceof LeaseLostError) throw error;
        // The observation was MADE — a third party was dialled — and the row
        // still says `expected`. Reporting the phase over that bakes the loss
        // into a scorecard that is inserted once and never patched.
        unattached.set(entry.evidenceKey, evidence.observedEndpoint);
        logger.error("[bench] attaching probe evidence failed", error, {
          ...logContext,
          evidenceKey: entry.evidenceKey,
        });
      }
    };

    /** Run the pinned conformance suites and bind the persisted run. */
    const runConformanceRow = async (item: {
      entry: BenchmarkRosterEntry;
      spec: BenchmarkConformanceSpec;
    }): Promise<void> => {
      if (windDown.reason || leaseLost) return;
      const { entry, spec } = item;
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
        await attachWithRetry({ evidenceKey: entry.evidenceKey, runId }, () =>
          deps.attachConformance({
            job: claimed,
            evidenceKey: entry.evidenceKey,
            conformanceRunId: runId,
          }),
        );
      } catch (error) {
        if (error instanceof LeaseLostError) throw error;
        // The suite RAN against the target. Same reasoning as a cell: the job
        // goes back for another attempt, and the resumed worker adopts the same
        // conformance run (same `externalRunId`) rather than re-dialling.
        unattached.set(entry.evidenceKey, runId);
        logger.error("[bench] attaching conformance evidence failed", error, {
          ...logContext,
          evidenceKey: entry.evidenceKey,
          runId,
        });
      }
    };

    /** Collect one child's failure without letting it abandon its siblings. */
    const settle = async <T extends { entry: BenchmarkRosterEntry }>(
      item: T,
      run: (item: T) => Promise<void>,
    ): Promise<void> => {
      try {
        await run(item);
      } catch (error) {
        if (error instanceof LeaseLostError) {
          leaseLost ??= error;
          return;
        }
        logger.error("[bench] child aborted", error, {
          ...logContext,
          evidenceKey: item.entry.evidenceKey,
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
        await settle(
          { entry, spec: resolveProbeSpec(claimed, entry) },
          runAuthProbeRow,
        );
      }
      for (const entry of owing("conformance_run")) {
        assertLeaseHeld();
        await settle(
          { entry, spec: resolveConformanceSpec(claimed, entry) },
          runConformanceRow,
        );
      }

      assertLeaseHeld();

      const limit = createConcurrencyLimiter(MAX_CONCURRENT_READ_ONLY_CELLS);
      await Promise.all(
        readOnly.map((item) => limit(() => settle(item, runCell))),
      );

      assertLeaseHeld();

      // STRICTLY one at a time, and only after every read-only cell has
      // settled. A write case creates artifacts named for this run and then
      // asserts over what it can see; a sibling writing concurrently is
      // indistinguishable from the target leaking another tenant's data.
      for (const item of writing) {
        assertLeaseHeld();
        await settle(item, runCell);
      }
    } finally {
      // After every cell has disconnected, and before anything is reported:
      // the scorecard's cleanup status has to describe a cleanup that already
      // happened.
      await runCleanup();
    }

    assertLeaseHeld();

    // REPORTING THE PHASE OVER UNATTACHED EVIDENCE IS THE ONE UNRECOVERABLE
    // MISTAKE HERE. `execution-complete` moves the run to `awaiting_evidence`
    // and hands finalization to the backend, and a scorecard is inserted once
    // and never patched — so evidence that was produced but never pointed at is
    // dropped from the result for good, silently, with the roster showing a
    // coverage gap that never existed. Handing the job back instead costs one
    // more attempt, and the re-attempt adopts the same children rather than
    // re-running them.
    // AN ARTIFACT CREATED BUT NEVER DURABLY RECORDED IS THE SAME LOSS.
    //
    // The row exists on somebody else's server and the only thing that knows
    // its id is this process. Reporting the phase over it hands the run to a
    // backend that has no record of what to clean up, so the job goes back for
    // another attempt instead — the artifacts route is idempotent on
    // `(run, tool, createdId)`, so the retry does not double-count.
    const unrecorded = ledger.unpersisted();
    if (unrecorded.length > 0) {
      throw new Error(
        `${unrecorded.length} artifact(s) were created but could not be recorded durably: ${unrecorded
          .slice(0, 20)
          .join(", ")}`,
      );
    }

    if (unattached.size > 0) {
      throw new Error(
        `${unattached.size} piece(s) of evidence were produced but could not be attached: ${[
          ...unattached.keys(),
        ].join(", ")}`,
      );
    }

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

  // Checked BEFORE the loop, not on the first claim: an unset or unsafe
  // CONVEX_HTTP_URL is a deployment mistake, and a worker that starts anyway
  // spends every poll cycle throwing the same configuration error into the
  // backoff path where nobody reads it.
  try {
    benchServiceConfig();
  } catch (error) {
    logger.warn("[bench] worker enabled but not startable", {
      error: error instanceof Error ? error.message : String(error),
    });
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
