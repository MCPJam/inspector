/**
 * eval-run-jobs-worker.ts — recovers durable hosted eval runs whose replica
 * was lost (`services/evals/durable-run.ts`, backend `convex/evalRunJobs.ts`).
 *
 * Polls the backend for a job whose lease lapsed, mints the launcher's
 * org-scoped bearer (`getConvexBearerForDelegation`, membership re-checked on
 * every mint), reconnects the run's servers, and resumes the run through the
 * EXISTING `prepareEvalRun()` → `execute()` pipeline with the run's own
 * idempotency key. The launch dedupes onto the SAME run — no second run, no
 * second charge — and the runner skips every trial already recorded or lost.
 *
 * One recovered run per instance at a time, like the scheduled worker.
 * Gated by `EVAL_RUN_JOBS_ENABLED === '1'` (with hosted mode), the same flag
 * that makes launches durable, so jobs are never created without a worker.
 */
import { logger } from "../utils/logger";
import { getConvexBearerForDelegation } from "../utils/v1-convex-token.js";
import { createAuthorizedManager } from "../routes/web/auth.js";
import { prepareEvalRun, shouldSkipExecution } from "../routes/shared/evals.js";
import { fetchSuiteRunServerSelection } from "../routes/v1/evals.js";
import { WEB_CALL_TIMEOUT_MS } from "../config.js";
import { createConvexClient } from "./evals/route-helpers.js";
import {
  environmentServerIds,
  environmentServerNames,
  resolveEnvironmentForLaunch,
  EVAL_LAUNCH_SERVER_SOURCE,
  type ResolvedEnvironmentForLaunch,
} from "./environments/resolve.js";
import {
  claimDurableRun,
  durableRunsEnabled,
  type DurableRunHandle,
  type DurableRunInputs,
} from "./evals/durable-run.js";

const POLL_INTERVAL_MS = 15_000;
const POLL_JITTER_MS = 5_000;
const ERROR_BACKOFF_MS = 60_000;

/** Resume one claimed run end-to-end. Never throws. */
export async function resumeDurableRun(
  handle: DurableRunHandle,
): Promise<void> {
  const { claim } = handle;
  const logContext = { runId: claim.runId, attempt: claim.attempt };
  let manager:
    Awaited<ReturnType<typeof createAuthorizedManager>>["manager"] | null =
    null;
  let executed = false;
  try {
    const inputs = JSON.parse(claim.inputs) as DurableRunInputs;
    const bearer = await getConvexBearerForDelegation(
      claim.externalId,
      claim.organizationId,
    );
    // The same server selection the scheduled worker connects: an
    // environment's resolved closed set, else the suite's saved selection.
    const selection: {
      serverIds: string[];
      serverNames: string[];
      resolvedEnvironment?: ResolvedEnvironmentForLaunch;
    } = inputs.environmentId
      ? await (async () => {
          const resolved = await resolveEnvironmentForLaunch(
            createConvexClient(bearer),
            {
              serverSource: EVAL_LAUNCH_SERVER_SOURCE,
              projectId: inputs.projectId,
              environmentId: inputs.environmentId!,
            },
          );
          return {
            serverIds: environmentServerIds(resolved),
            serverNames: environmentServerNames(resolved),
            resolvedEnvironment: resolved,
          };
        })()
      : await fetchSuiteRunServerSelection(
          bearer,
          inputs.suiteId,
          undefined,
          "authorized",
        );
    const authorized = await createAuthorizedManager(
      {},
      bearer,
      inputs.projectId,
      selection.serverIds,
      WEB_CALL_TIMEOUT_MS,
      undefined,
      undefined,
      { serverNames: selection.serverNames },
    );
    manager = authorized.manager;

    const prepared = await prepareEvalRun(manager, {
      suiteId: inputs.suiteId,
      projectId: inputs.projectId,
      tests: [],
      serverIds: selection.serverIds,
      serverNames: selection.serverNames,
      convexAuthToken: bearer,
      suiteRerun: true,
      source: inputs.source,
      // The run's own key: the launch dedupes onto the run being recovered.
      idempotencyKey: claim.idempotencyKey,
      ...(inputs.environmentId ? { environmentId: inputs.environmentId } : {}),
      ...(selection.resolvedEnvironment
        ? { resolvedEnvironment: selection.resolvedEnvironment }
        : {}),
      ...(inputs.namedHostId ? { namedHostId: inputs.namedHostId } : {}),
      ...(inputs.caseIds ? { caseIds: inputs.caseIds } : {}),
      ...(inputs.iterationOverride
        ? { iterationOverride: inputs.iterationOverride }
        : {}),
      ...(inputs.runGroupId ? { runGroupId: inputs.runGroupId } : {}),
      durable: { resume: handle },
    } as Parameters<typeof prepareEvalRun>[1]);

    if (prepared.runId !== claim.runId) {
      // Never drive a run other than the one this job is for.
      logger.error(
        "[eval-run-jobs] relaunch landed on another run",
        undefined,
        {
          ...logContext,
          landedOn: prepared.runId,
        },
      );
      return;
    }
    if (shouldSkipExecution(prepared)) {
      logger.info("[eval-run-jobs] run needs no execution", logContext);
      return;
    }
    executed = true;
    // `execute` releases the job once the runner has finalized the run.
    await prepared.execute();
  } catch (error) {
    logger.error("[eval-run-jobs] recovery failed", error, logContext);
  } finally {
    // Not executed: let the lease lapse so a later attempt (or, past the
    // attempt budget, the stale watchdog) settles the run.
    if (!executed) handle.stop();
    if (manager) {
      await manager.disconnectAllServers().catch((error) =>
        logger.warn("[eval-run-jobs] disconnect failed", {
          ...logContext,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export interface EvalRunJobsWorkerHandle {
  stop: () => Promise<void>;
}

export function isEvalRunJobsWorkerEnabled(): boolean {
  return durableRunsEnabled();
}

export function startEvalRunJobsWorker(options?: {
  claim?: () => Promise<DurableRunHandle | "no_job" | null>;
  resume?: typeof resumeDurableRun;
}): EvalRunJobsWorkerHandle {
  const abort = new AbortController();
  const claim = options?.claim ?? (() => claimDurableRun());
  const resume = options?.resume ?? resumeDurableRun;
  logger.info("[eval-run-jobs] worker started");
  const loop = (async () => {
    while (!abort.signal.aborted) {
      let waitMs =
        POLL_INTERVAL_MS + Math.floor(Math.random() * POLL_JITTER_MS);
      try {
        const claimed = await claim();
        if (claimed && claimed !== "no_job") {
          await resume(claimed);
          waitMs = 1_000;
        }
      } catch (error) {
        logger.warn("[eval-run-jobs] poll failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        waitMs = ERROR_BACKOFF_MS;
      }
      await sleep(waitMs, abort.signal);
    }
    logger.info("[eval-run-jobs] worker stopped");
  })();
  return {
    stop: async () => {
      abort.abort();
      await loop;
    },
  };
}
