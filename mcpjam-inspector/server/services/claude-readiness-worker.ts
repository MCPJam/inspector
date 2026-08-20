/**
 * claude-readiness-worker.ts — polling executor for hosted readiness runs.
 *
 * Grades a connector against Anthropic's directory requirements on an
 * inspector node, for a run somebody enqueued through the v1 API. Same
 * pull/claim architecture as `scheduled-evals-worker.ts` and
 * `production-checks-worker.ts`, and for the same reason: an inspector node is
 * not addressable from Convex, there is more than one of them, and the backend
 * never calls the inspector.
 *
 * TWO THINGS ARE DIFFERENT from its siblings, and both come from what a
 * readiness run actually does — dial a third party's server:
 *
 *   1. THE TRANSPORT IS THE PINNED STREAMING ONE, not `fetch`. Every URL in a
 *      readiness run is chosen by somebody else: the connector URL by the
 *      requester, and then the redirect chain, the `resource_metadata`
 *      pointer, and the authorization server by the target itself. On a hosted
 *      node that is an SSRF surface, so the guard is threaded into the SDK
 *      runner rather than left to the caller to remember.
 *
 *   2. IT HEARTBEATS WHILE IT WORKS. A run takes long enough that the lease
 *      would expire under it, and a heartbeat that comes back `alive: false`
 *      is the node's signal to STOP — its lease is gone, the run was cancelled
 *      or swept, and continuing would dial a third party's server for a result
 *      nothing will accept.
 *
 * ONE switch, and it is the backend's: being a worker at all requires
 * `CONVEX_HTTP_URL` + `INSPECTOR_SERVICE_TOKEN`. A deployment without them is
 * not an infrastructure peer and never starts the loop.
 */

import { runClaudeReadiness } from "@mcpjam/sdk";
import type { ClaudeReadinessResult, ClaudeRunnerCapability } from "@mcpjam/sdk";

import { createStreamingPinnedFetch } from "../utils/pinned-fetch.js";
import { logger } from "../utils/logger";

const POLL_INTERVAL_MS = 10_000;
const POLL_JITTER_MS = 5_000;
/** Backoff after claim/transport errors so a broken backend isn't hammered. */
const ERROR_BACKOFF_MS = 60_000;
/** Per-request cap so a stalled Convex can't wedge the loop. */
const SERVICE_ROUTE_TIMEOUT_MS = 15_000;
/**
 * Well inside the backend's ten-minute lease, so one dropped heartbeat is not
 * a swept run.
 */
const HEARTBEAT_INTERVAL_MS = 60_000;
/** Per-request budget inside a run. The run-level cap is below. */
const REQUEST_TIMEOUT_MS = 20_000;
/**
 * The whole run. A readiness grade that has not finished in five minutes is
 * not going to produce a better answer by continuing, and the lease behind it
 * is finite.
 */
const RUN_TIMEOUT_MS = 5 * 60_000;

/**
 * What a hosted node can actually do.
 *
 * `dns` and `raw-origin` only: there is no browser here and no interactive
 * authorization, so the browser-quality and interactive-OAuth checks report
 * unevaluated rather than guessing. Recording it is what makes the resulting
 * coverage legible instead of mysterious.
 */
const HOSTED_CAPABILITIES: ClaudeRunnerCapability[] = ["dns", "raw-origin"];

export interface ClaimedReadinessRun {
  runId: string;
  jobId: string;
  serverUrl: string;
  attemptCount: number;
}

type ClaimOutcome =
  | { kind: "claimed"; claim: ClaimedReadinessRun }
  | { kind: "empty" }
  | { kind: "disabled" };

function requiredEnv(): { convexUrl: string; serviceToken: string } | null {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  const serviceToken = process.env.INSPECTOR_SERVICE_TOKEN;
  if (!convexUrl || !serviceToken) return null;
  return { convexUrl, serviceToken };
}

async function postServiceRoute(
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const env = requiredEnv();
  if (!env) {
    throw new Error(
      "Claude readiness worker requires CONVEX_HTTP_URL and INSPECTOR_SERVICE_TOKEN",
    );
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    SERVICE_ROUTE_TIMEOUT_MS,
  );
  let response: Response;
  // Parsed INSIDE the timeout. Clearing the timer when the headers arrive left
  // the body read with no deadline at all, so a peer that answers and then
  // stalls mid-body holds this open forever — and both the claim and the
  // heartbeat wait on it, so one slow body wedges the loop the timeout exists
  // to protect.
  let parsed: any = null;
  try {
    response = await fetch(`${env.convexUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-inspector-service-token": env.serviceToken,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      // The scheme check is on the CONFIGURED host. `fetch` follows redirects
      // and replays headers wherever it lands, so a 3xx could carry the
      // service token to another origin. Refuse to follow.
      redirect: "manual",
    });
    try {
      parsed = await response.json();
    } catch {
      // tolerated; status carries the signal
    }
  } finally {
    clearTimeout(timeout);
  }
  return { status: response.status, body: parsed };
}

const CLAIM_PATH = "/internal/v1/claude-readiness/runs/claim";
const INGEST_PATH = "/internal/v1/claude-readiness/runs";
const HEARTBEAT_PATH = "/internal/v1/claude-readiness/runs/heartbeat";

async function claimNext(): Promise<ClaimOutcome> {
  const { status, body } = await postServiceRoute(CLAIM_PATH, {});
  // 404 = the backend does not serve this route yet. Long backoff, so
  // deploying it does not need an inspector restart.
  if (status === 404) return { kind: "disabled" };
  if (status !== 200 || !body?.ok) {
    throw new Error(`claim failed (${status}): ${JSON.stringify(body)}`);
  }
  if (body.claimed !== true) return { kind: "empty" };

  const run = body.run;
  if (
    typeof run?.runId !== "string" ||
    typeof run?.jobId !== "string" ||
    typeof run?.serverUrl !== "string"
  ) {
    throw new Error("claim returned a malformed payload");
  }
  return {
    kind: "claimed",
    claim: {
      runId: run.runId,
      jobId: run.jobId,
      serverUrl: run.serverUrl,
      attemptCount:
        typeof run.attemptCount === "number" ? run.attemptCount : 1,
    },
  };
}

/**
 * Keep the lease alive, and stop the run when it is gone.
 *
 * The abort is the important half. `alive: false` means the row moved on —
 * cancelled by its requester, or swept and re-queued to another node — and a
 * node that keeps going is dialling somebody else's server to produce a result
 * the backend will reject.
 */
function startHeartbeat(
  claim: ClaimedReadinessRun,
  onLeaseLost: () => void,
): { stop: () => void } {
  const timer = setInterval(() => {
    void (async () => {
      try {
        const { status, body } = await postServiceRoute(HEARTBEAT_PATH, {
          runId: claim.runId,
          jobId: claim.jobId,
        });
        if (status === 200 && body?.alive === false) {
          logger.info("[claude-readiness] lease lost, stopping run", {
            runId: claim.runId,
          });
          onLeaseLost();
        }
      } catch (error) {
        // A missed heartbeat is not a lost lease: the interval is a minute and
        // the lease is ten, so a transient failure has nine more chances.
        logger.warn("[claude-readiness] heartbeat failed", {
          runId: claim.runId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

/**
 * Reject once `ms` has passed, and STOP the work rather than merely leaving it.
 *
 * A race alone abandons the run: nothing tells it to stop, so it keeps its MCP
 * connection open and keeps dialling the connector with nobody left to read
 * the answer. That is the same mistake cancellation was fixed for — "we
 * stopped waiting" is not "we stopped asking" — so the deadline trips the same
 * controller.
 */
function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  onExpiry: () => void,
): Promise<T> {
  // The timer is cleared in a `finally` rather than left to `unref`. A losing
  // arm of a `Promise.race` is not cancelled by losing: without this, every
  // completed run leaves a live timer that fires minutes later and aborts a
  // controller belonging to a run that already finished.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onExpiry();
      reject(new Error("readiness run exceeded its time budget"));
    }, ms);
    timer.unref?.();
  });

  return Promise.race([work, expiry]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** The small, indexed summary the row carries. The report goes to a blob. */
function summarize(result: ClaudeReadinessResult) {
  return {
    overallStatus: result.status,
    lanes: result.lanes.map((lane) => ({
      lane: lane.lane,
      status: lane.status,
      evaluated: lane.coverage.evaluated,
      notEvaluated: lane.coverage.notEvaluated,
      notApplicable: lane.coverage.notApplicable,
      missingInputs: lane.coverage.missingInputs,
    })),
    authMode: result.context.authMode,
    capabilities: result.context.capabilities,
    policySnapshotDate: result.policySnapshotDate,
    engineVersion: result.engineVersion,
  };
}

/** Execute one claimed run end-to-end. Never throws. */
export async function executeClaimedRun(
  claim: ClaimedReadinessRun,
): Promise<void> {
  let leaseLost = false;
  // The abort is what makes a cancel STOP THE PROBING rather than merely stop
  // us waiting for it. A run whose lease is gone has no reader; continuing to
  // dial the target would be traffic nobody asked for and nobody will read.
  const abort = new AbortController();
  const heartbeat = startHeartbeat(claim, () => {
    leaseLost = true;
    abort.abort(new Error("the readiness run's lease was cancelled or swept"));
  });

  try {
    const result = await withDeadline(
      runClaudeReadiness({
        serverUrl: claim.serverUrl,
        // THE GUARD, threaded all the way into the MCP transport. Every URL
        // this run dials after the first is chosen by the target.
        fetchFn: createStreamingPinnedFetch({
          hosted: true,
          targetLabel: "connector",
        }),
        timeoutMs: REQUEST_TIMEOUT_MS,
        capabilities: HOSTED_CAPABILITIES,
        signal: abort.signal,
      }),
      RUN_TIMEOUT_MS,
      () =>
        abort.abort(new Error("the readiness run exceeded its time budget")),
    );

    if (leaseLost) {
      // Finished, but into a lease that has moved on. Posting would be
      // rejected on the job id anyway; not posting keeps a blob from being
      // stored for a row that will never read it.
      logger.info("[claude-readiness] discarding a result whose lease moved", {
        runId: claim.runId,
      });
      return;
    }

    const { status, body } = await postServiceRoute(INGEST_PATH, {
      runId: claim.runId,
      jobId: claim.jobId,
      ...summarize(result),
      report: result,
    });
    if (status !== 200 || body?.ok !== true) {
      logger.warn("[claude-readiness] ingest rejected the result", {
        runId: claim.runId,
        status,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (leaseLost) {
      // Cancelled or swept, and the abort above is why this threw. Posting
      // `runner_error` would file a deliberate stop as evidence against a
      // connector that did nothing wrong — the exact confusion the cancel
      // endpoint's own semantics exist to prevent. `return` still runs the
      // `finally` below, so the heartbeat stops either way.
      logger.info("[claude-readiness] stopped a run whose lease moved", {
        runId: claim.runId,
      });
      return;
    }
    // A FAILURE IS A RESULT. Left unreported, the row sits `running` until the
    // lease expires and recovery re-queues it — which re-dials a third party's
    // server for a run that already told us why it cannot work.
    try {
      await postServiceRoute(INGEST_PATH, {
        runId: claim.runId,
        jobId: claim.jobId,
        outcome: "failed",
        terminalReason: "runner_error",
        errorMessage: message,
      });
    } catch (reportError) {
      // Best-effort: the lease sweep recovers the row.
      logger.warn("[claude-readiness] failed to report a failed run", {
        runId: claim.runId,
        error:
          reportError instanceof Error
            ? reportError.message
            : String(reportError),
      });
    }
    logger.warn("[claude-readiness] run failed", {
      runId: claim.runId,
      error: message,
    });
  } finally {
    heartbeat.stop();
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}

export interface ClaudeReadinessWorkerHandle {
  /** Aborts polling and resolves once the loop (incl. an in-flight run) settles. */
  stop: () => Promise<void>;
}

/**
 * Start the polling loop. Called unconditionally from server bootstrap — it
 * self-gates on the service-token env below, so a deployment that is not an
 * infrastructure peer gets an inert handle.
 *
 * ONE RUN IN FLIGHT PER INSTANCE. A readiness run dials somebody else's
 * server; the global per-organization cap lives in Convex, where it can count
 * across nodes, and this keeps a single node from being the thing that
 * multiplies it.
 */
export function startClaudeReadinessWorker(options?: {
  /** Test seam: overrides the claim/execute pair. */
  claim?: typeof claimNext;
  execute?: typeof executeClaimedRun;
}): ClaudeReadinessWorkerHandle {
  const abort = new AbortController();
  const claim = options?.claim ?? claimNext;
  const execute = options?.execute ?? executeClaimedRun;

  // Not a worker peer — every local dev and self-hosted inspector lands here.
  // Silent on purpose: with no flag to contradict, absent credentials are the
  // normal case rather than a misconfiguration worth warning about.
  if (!requiredEnv()) {
    return { stop: async () => {} };
  }

  logger.info("[claude-readiness] worker started");

  const loop = (async () => {
    while (!abort.signal.aborted) {
      let waitMs =
        POLL_INTERVAL_MS + Math.floor(Math.random() * POLL_JITTER_MS);
      try {
        const outcome = await claim();
        if (outcome.kind === "disabled") {
          waitMs = ERROR_BACKOFF_MS;
        } else if (outcome.kind === "claimed") {
          await execute(outcome.claim);
          // Drain mode: runs arrive in bursts when somebody grades a project.
          waitMs = 1_000;
        }
      } catch (error) {
        logger.warn("[claude-readiness] poll failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        waitMs = ERROR_BACKOFF_MS;
      }
      await sleep(waitMs, abort.signal);
    }
    logger.info("[claude-readiness] worker stopped");
  })();

  return {
    stop: async () => {
      abort.abort();
      // Bounded by the caller's shutdown force-exit timer; a run that outlasts
      // it is recovered by the backend's stale-lease sweep.
      await loop;
    },
  };
}
