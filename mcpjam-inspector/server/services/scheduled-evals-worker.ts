/**
 * scheduled-evals-worker.ts — polling executor for scheduled eval runs
 * (synthetic monitors).
 *
 * Pull/claim architecture: the Convex cron sweeps due suite schedules into
 * `scheduledRunTrigger` rows; this long-running loop claims one at a time
 * over the service-token-gated `/internal/v1/scheduled-eval-runs/*` routes,
 * mints a short-lived org-scoped JWT for the schedule's creator
 * (`getConvexBearerForDelegation` — membership re-verified on every mint),
 * and drives the EXISTING `prepareEvalRun()` → `execute()` pipeline, exactly
 * like the public /api/v1 detached path. The backend never calls the
 * Inspector.
 *
 * Concurrency: hard cap of ONE scheduled run per Inspector instance — the
 * loop doesn't poll again until the in-flight run settles. Multiple Railway
 * instances race safely (claim is an atomic Convex mutation).
 *
 * Gated by `SCHEDULED_EVALS_WORKER_ENABLED === '1'` (the backend cron and
 * write surface have their own `SCHEDULED_EVALS_ENABLED` gate).
 */

import { WEB_CALL_TIMEOUT_MS } from "../config.js";
import { logger } from "../utils/logger";
import { getConvexBearerForDelegation } from "../utils/v1-convex-token.js";
import { createAuthorizedManager } from "../routes/web/auth.js";
import {
  prepareEvalRun,
  type PreparedEvalRun,
} from "../routes/shared/evals.js";
import { fetchSuiteRunServerSelection } from "../routes/v1/evals.js";

const POLL_INTERVAL_MS = 15_000;
const POLL_JITTER_MS = 5_000;
/** Backoff after claim/transport errors so a broken backend isn't hammered. */
const ERROR_BACKOFF_MS = 60_000;
/** Per-request cap on claim/complete calls so a stalled Convex can't wedge the loop. */
const SERVICE_ROUTE_TIMEOUT_MS = 15_000;

type ClaimedScheduledRun = {
  triggerId: string;
  suiteId: string;
  suiteName: string;
  organizationId: string;
  projectId: string | null;
  createdByExternalId: string;
  scheduledFor: number;
};

export function isScheduledEvalsWorkerEnabled(): boolean {
  return process.env.SCHEDULED_EVALS_WORKER_ENABLED === "1";
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
      "Scheduled evals worker requires CONVEX_HTTP_URL and INSPECTOR_SERVICE_TOKEN",
    );
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SERVICE_ROUTE_TIMEOUT_MS);
  let response: Response;
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
  } finally {
    clearTimeout(timeout);
  }
  let parsed: any = null;
  try {
    parsed = await response.json();
  } catch {
    // tolerated; status carries the signal
  }
  return { status: response.status, body: parsed };
}

async function claimNext(
  claimedBy: string,
): Promise<ClaimedScheduledRun | null | "disabled"> {
  const { status, body } = await postServiceRoute(
    "/internal/v1/scheduled-eval-runs/claim",
    { claimedBy },
  );
  // 404 = SCHEDULED_EVALS_ENABLED is off backend-side; treat as "nothing to
  // do" with a long backoff rather than an error.
  if (status === 404) return "disabled";
  if (status !== 200 || !body?.ok) {
    throw new Error(`claim failed (${status}): ${JSON.stringify(body)}`);
  }
  return (body.claimed as ClaimedScheduledRun | null) ?? null;
}

async function reportComplete(args: {
  triggerId: string;
  ok: boolean;
  runId?: string;
  failureReason?: string;
}): Promise<void> {
  try {
    await postServiceRoute("/internal/v1/scheduled-eval-runs/complete", args);
  } catch (error) {
    // Best-effort: an unreported claim is recovered by the backend's stale
    // lease sweep.
    logger.warn("[scheduled-evals] failed to report completion", {
      triggerId: args.triggerId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Map a setup-phase failure to the completion reason the backend pauses
 * schedules on. Deliberately anchored to the two CANONICAL markers — the
 * backend's `billing_limit_reached` billing-error code and this server's
 * own delegated-mint failure message — because pausing a schedule on a
 * loose substring (an MCP server error that merely mentions "quota")
 * would stop monitoring for a transient, retryable failure. Everything
 * else records a plain failure and the schedule tries again next window.
 */
export function classifyFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/billing_limit_reached/i.test(message)) return "quota_exhausted";
  if (/delegated token exchange failed \(40[13]\)/i.test(message)) {
    return "auth";
  }
  return `run_create_failed: ${message.slice(0, 160)}`;
}

/** Execute one claimed trigger end-to-end. Never throws. */
export async function executeClaimedRun(
  claimed: ClaimedScheduledRun,
): Promise<void> {
  const logContext = {
    triggerId: claimed.triggerId,
    suiteId: claimed.suiteId,
    suiteName: claimed.suiteName,
  };
  if (!claimed.projectId) {
    await reportComplete({
      triggerId: claimed.triggerId,
      ok: false,
      failureReason: "run_create_failed: suite has no project scope",
    });
    return;
  }

  let manager: Awaited<ReturnType<typeof createAuthorizedManager>>["manager"] | null =
    null;
  try {
    const bearer = await getConvexBearerForDelegation(
      claimed.createdByExternalId,
      claimed.organizationId,
    );
    const selection = await fetchSuiteRunServerSelection(
      bearer,
      claimed.suiteId,
      undefined,
    );

    // Empty caller context = plain-JWT caller (locked by caller-context
    // contract test); the delegated JWT is the principal.
    const authorized = await createAuthorizedManager(
      {},
      bearer,
      claimed.projectId,
      selection.serverIds,
      WEB_CALL_TIMEOUT_MS,
      undefined,
      undefined,
      { serverNames: selection.serverNames },
    );
    manager = authorized.manager;

    let prepared: PreparedEvalRun;
    try {
      prepared = await prepareEvalRun(manager, {
        suiteId: claimed.suiteId,
        tests: [],
        serverIds: selection.serverIds,
        serverNames: selection.serverNames,
        convexAuthToken: bearer,
        suiteRerun: true,
        source: "schedule",
        // Claim retries can never double-create a run: the mutation's
        // idempotency lookup wins over the 30s fingerprint window.
        idempotencyKey: claimed.triggerId,
      });
    } catch (error) {
      logger.error("[scheduled-evals] run setup failed", error, logContext);
      await reportComplete({
        triggerId: claimed.triggerId,
        ok: false,
        failureReason: classifyFailure(error),
      });
      return;
    }

    logger.info("[scheduled-evals] executing scheduled run", {
      ...logContext,
      runId: prepared.runId,
    });

    try {
      await prepared.execute();
    } catch (error) {
      // The run exists and the runner owns terminal run status (it
      // finalizes failed runs itself before rethrowing) — the TRIGGER did
      // its job. Run-level failure handling (notifications, consecutive
      // failure counting) lives on the run lifecycle.
      logger.error("[scheduled-evals] scheduled run failed", error, {
        ...logContext,
        runId: prepared.runId,
      });
    }

    await reportComplete({
      triggerId: claimed.triggerId,
      ok: true,
      runId: prepared.runId,
    });
  } catch (error) {
    logger.error("[scheduled-evals] claim execution failed", error, logContext);
    await reportComplete({
      triggerId: claimed.triggerId,
      ok: false,
      failureReason: classifyFailure(error),
    });
  } finally {
    if (manager) {
      await manager.disconnectAllServers().catch(() => {});
    }
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

export interface ScheduledEvalsWorkerHandle {
  /** Aborts polling and resolves once the loop (incl. an in-flight run) settles. */
  stop: () => Promise<void>;
}

/**
 * Start the polling loop. Call once from server bootstrap when
 * {@link isScheduledEvalsWorkerEnabled}. Returns a handle whose `stop()`
 * ends the loop after the in-flight run (if any) settles.
 */
export function startScheduledEvalsWorker(options?: {
  claimedBy?: string;
  /** Test seam: overrides the claim/execute pair. */
  claim?: typeof claimNext;
  execute?: typeof executeClaimedRun;
}): ScheduledEvalsWorkerHandle {
  const abort = new AbortController();
  const claimedBy =
    options?.claimedBy ??
    `inspector-${process.env.RAILWAY_REPLICA_ID ?? process.pid}`;
  const claim = options?.claim ?? claimNext;
  const execute = options?.execute ?? executeClaimedRun;

  if (!requiredEnv()) {
    logger.warn(
      "[scheduled-evals] worker enabled but CONVEX_HTTP_URL / INSPECTOR_SERVICE_TOKEN missing; not starting",
    );
    return { stop: async () => {} };
  }

  logger.info("[scheduled-evals] worker started", { claimedBy });

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
          await execute(claimed);
          // Drain mode: if a trigger was waiting, check again immediately —
          // another suite's window may be queued behind it.
          waitMs = 1_000;
        }
      } catch (error) {
        logger.warn("[scheduled-evals] poll failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        waitMs = ERROR_BACKOFF_MS;
      }
      await sleep(waitMs, abort.signal);
    }
    logger.info("[scheduled-evals] worker stopped");
  })();

  return {
    stop: async () => {
      abort.abort();
      // Bounded by the caller's shutdown force-exit timer; runs that
      // outlast it are recovered by the backend's stale-lease sweep.
      await loop;
    },
  };
}
