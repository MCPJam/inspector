/**
 * E4.3 — the resume worker: picks up eval runs a lost or shut-down worker
 * left behind, and finishes them.
 *
 * A RESUMABLE run (`evalRunLeases:markEvalRunResumable` accepted it at
 * launch) that loses its worker is not timed out whole any more. The backend
 * keeps every finished iteration, requeues the interrupted ones it can PROVE
 * never dispatched anything effectful (the shared replay-safety rule — see
 * `infra-retry.ts`), records the rest as excluded `worker_lost` rows, and
 * parks the run `awaiting_worker`. This loop claims such a run over the
 * service-token-gated `/internal/v1/eval-run-resume/*` routes — the same
 * claim/complete shape as the scheduled-evals worker — mints a short-lived
 * token for the run's creator, and executes ONLY the requeued rows
 * (`prepareSuiteResumeFromRun`):
 *
 *  - the run's frozen config comes from `evalRunLeases:getRunResumeContext`,
 *    and its servers from the run's own stored replay config — never the live
 *    suite — so a resume runs exactly what the launch froze;
 *  - the claim handed us the run's driver token, so this process becomes the
 *    run's driver and every older worker is fenced (`LEASE_LOST`);
 *  - each row is claimed before it runs; a finished row refuses the claim and
 *    is skipped, so nothing that already has an outcome is re-run or re-billed;
 *  - the run keeps its ORIGINAL execution deadline — a resume never buys a
 *    fresh clock.
 *
 * A resume that cannot start (the creator's token cannot be minted, the
 * environment no longer resolves) reports `ok: false` with the reason; the
 * backend parks the run for one more attempt or times it out — it never loops.
 *
 * Gated by `EVAL_RESUME_ENABLED` (which also requires
 * `MCPJAM_EVAL_ITERATION_LEASES`), plus `CONVEX_HTTP_URL` and
 * `INSPECTOR_SERVICE_TOKEN`.
 */
import { logger } from "../../utils/logger.js";
import { getConvexBearerForDelegation } from "../../utils/v1-convex-token.js";
import { createConvexClient } from "./route-helpers.js";
import { prepareSuiteResumeFromRun } from "./resume-suite-run.js";
import { evalResumeEnabled, isSilentStop } from "./run-lease.js";

const POLL_INTERVAL_MS = 20_000;
const POLL_JITTER_MS = 5_000;
/** Backoff after claim/transport errors so a broken backend isn't hammered. */
const ERROR_BACKOFF_MS = 60_000;
/** Per-request cap on claim/complete calls so a stalled Convex can't wedge the loop. */
const SERVICE_ROUTE_TIMEOUT_MS = 15_000;
/** How long `stop()` waits for the loop before letting shutdown proceed. */
const STOP_WAIT_MS = 1_000;

export type ClaimedEvalRunResume = {
  runId: string;
  suiteId: string;
  projectId: string | null;
  organizationId: string;
  createdByExternalId: string;
  environmentId?: string | null;
  /** This worker is now the run's driver. */
  driverToken: string;
  resumeAttempt: number;
  /** The requeued rows (informational: claims are the real fence). */
  resumeIterationIds: string[];
  /** The run's ORIGINAL deadline. */
  executionDeadlineAt: number;
};

export function isEvalResumeWorkerEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return evalResumeEnabled(env);
}

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
      "Eval resume worker requires CONVEX_HTTP_URL and INSPECTOR_SERVICE_TOKEN",
    );
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    SERVICE_ROUTE_TIMEOUT_MS,
  );
  let response: Response;
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
    });
    // Under the same deadline: a backend that sends headers and then stalls
    // the body must not wedge the (single-resume) loop.
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

export async function claimNextResume(
  claimedBy: string,
): Promise<ClaimedEvalRunResume | null | "disabled"> {
  const { status, body } = await postServiceRoute(
    "/internal/v1/eval-run-resume/claim",
    { claimedBy },
  );
  // 404 = the backend half is not deployed (or is off): nothing to do.
  if (status === 404) return "disabled";
  if (status !== 200 || !body || body.ok === false) {
    throw new Error(`resume claim failed (${status}): ${JSON.stringify(body)}`);
  }
  return (body.claimed as ClaimedEvalRunResume | null) ?? null;
}

export async function reportResumeComplete(args: {
  runId: string;
  driverToken: string;
  ok: boolean;
  failureReason?: string;
}): Promise<void> {
  try {
    await postServiceRoute("/internal/v1/eval-run-resume/complete", args);
  } catch (error) {
    // Best-effort: an unreported resume converges through the stale-run
    // watchdog (it parks again or times out).
    logger.warn("[eval-resume] failed to report completion", {
      runId: args.runId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Why a resume could not start, as a short, stable reason the backend
 * records when it parks the run. Anchored to canonical markers, never loose
 * prose — the same discipline as the scheduled worker's classifier.
 */
export function classifyResumeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/delegated token exchange failed \(40[13]\)/i.test(message)) {
    return "auth";
  }
  if (/billing_limit_reached|spend_budget_reached/i.test(message)) {
    return "quota_exhausted";
  }
  if (/RUN_NOT_RESUMABLE/.test(message)) return "not_resumable";
  return `resume_failed: ${message.slice(0, 160)}`;
}

/** Execute one claimed resume end-to-end. Never throws. */
export async function executeClaimedResume(
  claimed: ClaimedEvalRunResume,
  deps: {
    mintBearer?: typeof getConvexBearerForDelegation;
    prepare?: typeof prepareSuiteResumeFromRun;
    complete?: typeof reportResumeComplete;
  } = {},
): Promise<void> {
  const mintBearer = deps.mintBearer ?? getConvexBearerForDelegation;
  const prepare = deps.prepare ?? prepareSuiteResumeFromRun;
  const report = deps.complete ?? reportResumeComplete;
  const logContext = {
    runId: claimed.runId,
    suiteId: claimed.suiteId,
    resumeAttempt: claimed.resumeAttempt,
    resumeIterations: claimed.resumeIterationIds.length,
  };
  const complete = (ok: boolean, failureReason?: string) =>
    report({
      runId: claimed.runId,
      driverToken: claimed.driverToken,
      ok,
      ...(failureReason ? { failureReason } : {}),
    });

  let prepared: Awaited<ReturnType<typeof prepareSuiteResumeFromRun>>;
  try {
    // Re-minted for the creator on every resume: a creator who lost their
    // membership since launch cannot have their run finished for them.
    const bearer = await mintBearer(
      claimed.createdByExternalId,
      claimed.organizationId,
    );
    prepared = await prepare({
      convexClient: createConvexClient(bearer),
      convexAuthToken: bearer,
      runId: claimed.runId,
      driverToken: claimed.driverToken,
      executionDeadlineAt: claimed.executionDeadlineAt,
    });
  } catch (error) {
    // Could not even start (token, membership, an expired server credential,
    // a refused context): PARK — the backend retries once more or times the
    // run out. Never loop here.
    logger.warn("[eval-resume] resume could not start", {
      ...logContext,
      error: error instanceof Error ? error.message : String(error),
    });
    await complete(false, classifyResumeFailure(error));
    return;
  }

  logger.info("[eval-resume] resuming interrupted run", {
    ...logContext,
    rows: prepared.resumeIterationCount,
  });
  try {
    // Nothing was requeued (every row already has its outcome): the resume
    // is complete without running anything.
    if (prepared.resumeIterationCount === 0) {
      await complete(true);
      return;
    }
    await prepared.execute();
    await complete(true);
  } catch (error) {
    if (isSilentStop(error)) {
      // Shut down again (or superseded) mid-resume: the handback owns the
      // run, and reporting here would race it.
      logger.info("[eval-resume] resume handed off", logContext);
      return;
    }
    // The runner finalizes a run that failed while executing; report the
    // failure so a run that never reached a terminal state is parked rather
    // than left to the watchdog.
    logger.error("[eval-resume] resumed run failed", error, logContext);
    await complete(false, classifyResumeFailure(error));
  } finally {
    await prepared.cleanup().catch(() => {});
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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

export interface EvalResumeWorkerHandle {
  /** Ends polling; resolves once the loop (incl. an in-flight resume) settles. */
  stop: () => Promise<void>;
}

/**
 * Start the polling loop. ONE resume per process at a time: a resumed run is
 * a whole eval run, and a fleet recovering from a deploy must not stampede.
 */
export function startEvalResumeWorker(options?: {
  claimedBy?: string;
  /** Test seams. */
  claim?: typeof claimNextResume;
  execute?: typeof executeClaimedResume;
  pollIntervalMs?: number;
}): EvalResumeWorkerHandle {
  const abort = new AbortController();
  const claimedBy =
    options?.claimedBy ??
    `inspector-${process.env.RAILWAY_REPLICA_ID ?? process.pid}`;
  const claim = options?.claim ?? claimNextResume;
  const execute = options?.execute ?? executeClaimedResume;
  const pollIntervalMs = options?.pollIntervalMs ?? POLL_INTERVAL_MS;

  if (!options?.claim && !requiredEnv()) {
    logger.warn(
      "[eval-resume] worker enabled but CONVEX_HTTP_URL / INSPECTOR_SERVICE_TOKEN missing; not starting",
    );
    return { stop: async () => {} };
  }

  logger.info("[eval-resume] worker started", { claimedBy });

  const loop = (async () => {
    while (!abort.signal.aborted) {
      let waitMs = pollIntervalMs + Math.floor(Math.random() * POLL_JITTER_MS);
      try {
        const claimed = await claim(claimedBy);
        if (claimed === "disabled") {
          waitMs = ERROR_BACKOFF_MS;
        } else if (claimed) {
          await execute(claimed);
          // Drain: a deploy usually leaves several runs waiting.
          waitMs = 1_000;
        }
      } catch (error) {
        logger.warn("[eval-resume] poll failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        waitMs = ERROR_BACKOFF_MS;
      }
      await sleep(waitMs, abort.signal);
    }
    logger.info("[eval-resume] worker stopped");
  })();

  return {
    stop: async () => {
      abort.abort();
      // With the shutdown handoff on, an in-flight resume was already stopped
      // and handed back; with it off, nothing stopped it. Either way shutdown
      // never waits on a whole resumed run — the watchdog recovers it.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        loop,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, STOP_WAIT_MS);
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
    },
  };
}
