import { logger } from "../../utils/logger.js";
import { createConvexClient } from "./route-helpers.js";

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);

type DetachableEvalRun = {
  suiteId: string;
  runId: string;
  recorder?: {
    finalize(args: {
      status: "completed" | "failed" | "cancelled";
      summary?: {
        total: number;
        passed: number;
        failed: number;
        passRate: number;
      };
      notes?: string;
    }): Promise<void>;
  } | null;
  execute: () => Promise<void>;
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
