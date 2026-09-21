import { logger } from "../../utils/logger.js";
import { createConvexClient } from "./route-helpers.js";
import { TERMINAL_RUN_STATUSES } from "./run-status.js";
import { shouldSkipExecution } from "../../routes/shared/evals.js";

type DetachableEvalRun = {
  suiteId: string;
  runId: string;
  recorder?: {
    finalize(args: {
      status: "completed" | "failed" | "cancelled" | "timed_out";
      summary?: {
        total: number;
        passed: number;
        failed: number;
        passRate: number;
      };
      notes?: string;
      stopReason?: "user_cancelled" | "run_timeout" | "iteration_timeout";
    }): Promise<void>;
  } | null;
  execute: () => Promise<void>;
  /** Set when this "start" replayed an existing run — see `shouldSkipExecution`. */
  deduped?: boolean;
  /** The run's own status; terminal on a replay of a finished run. */
  status?: string;
};

async function isRunAlreadyTerminal(
  convexAuthToken: string,
  runId: string,
): Promise<boolean> {
  try {
    const run = await createConvexClient(convexAuthToken).query(
      "testSuites:getTestSuiteRun" as any,
      { runId },
    );
    return TERMINAL_RUN_STATUSES.has(String(run?.status));
  } catch {
    return false;
  }
}

function formatBackgroundFailureNote(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 500)
    : String(error).slice(0, 500);
}

export function detachPreparedEvalRun(args: {
  prepared: DetachableEvalRun;
  convexAuthToken: string;
  logPrefix: string;
  logContext: Record<string, unknown>;
  cleanup?: () => Promise<void> | void;
}) {
  const { prepared, convexAuthToken, logPrefix, logContext, cleanup } = args;

  // A REPLAY of a finished run has nothing to execute. Running it would repeat
  // every case and bill for it, over results that are already final — the
  // double-spend an idempotency key is sent to prevent. Guarded here rather
  // than at each call site so every surface that detaches a run inherits it.
  if (shouldSkipExecution(prepared)) {
    logger.info(`${logPrefix} idempotent replay — not re-executing`, {
      ...logContext,
      suiteId: prepared.suiteId,
      runId: prepared.runId,
      status: prepared.status,
    });
    void Promise.resolve(cleanup?.()).catch(() => {});
    return;
  }

  void Promise.resolve()
    .then(() => prepared.execute())
    .catch(async (error) => {
      logger.error(`${logPrefix} background eval run failed`, error, {
        ...logContext,
        suiteId: prepared.suiteId,
        runId: prepared.runId,
      });

      if (await isRunAlreadyTerminal(convexAuthToken, prepared.runId)) {
        return;
      }

      if (!prepared.recorder) {
        return;
      }

      await prepared.recorder
        .finalize({
          status: "failed",
          notes: formatBackgroundFailureNote(error),
        })
        .catch((finalizeError: unknown) => {
          logger.error(
            `${logPrefix} failed to finalize background eval run`,
            finalizeError,
            {
              ...logContext,
              suiteId: prepared.suiteId,
              runId: prepared.runId,
            },
          );
        });
    })
    .finally(() => {
      if (!cleanup) {
        return;
      }
      void Promise.resolve()
        .then(() => cleanup())
        .catch((error) => {
          logger.warn(`${logPrefix} background eval cleanup failed`, {
            ...logContext,
            suiteId: prepared.suiteId,
            runId: prepared.runId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    });
}
