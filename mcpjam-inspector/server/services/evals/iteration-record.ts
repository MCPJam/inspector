import type { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { HOSTED_MODE } from "../../config.js";
import { convexErrorData } from "../../routes/v1/convex-error-data.js";
import { translateConvexWriteError } from "../../routes/v1/convex-errors.js";
import { ErrorCode, WebRouteError } from "../../routes/web/errors";
import { logger } from "../../utils/logger";
import { asBillingRouteError } from "./billing-refusal.js";

const UPDATE_TEST_ITERATION = makeFunctionReference<"action">(
  "testSuites:updateTestIteration",
);

const HARNESS_ITERATION_RECORD_REQUIRED =
  "Could not record this eval iteration, which a hosted harness run needs " +
  "to provision its own computer, so the run was refused";

/**
 * Typed so the quick-run settle loop rethrows it: a run refused before it took
 * a row has nothing of its own to answer with, and the route would otherwise
 * report the case's latest iteration, another run's, as this one's result.
 */
export class HarnessIterationRecordError extends Error {}

export function missingIterationRecordError() {
  return new HarnessIterationRecordError(
    `${HARNESS_ITERATION_RECORD_REQUIRED}: the backend returned no iteration id`,
  );
}

/**
 * What to throw when a quick-run iteration could not be recorded, or undefined
 * to run it without a stored row (the legacy local fallback).
 *
 * A hosted run never executes without its row, because creating the row is
 * what admits and bills it. A coded backend refusal (not found, validation,
 * forbidden) is permanent and keeps its own status and words; only an uncoded
 * failure, such as a network error, is reported as billing being unconfirmed.
 */
export function iterationRecordFailure(
  error: unknown,
  params: {
    namedHostId?: string;
    runtimeVenue?: "hosted" | "local";
    requireRecord?: boolean;
  },
): Error | undefined {
  const refusal =
    asBillingRouteError(error) ??
    (!HOSTED_MODE
      ? null
      : typeof convexErrorData(error)?.code === "string"
        ? translateConvexWriteError(error, { resource: "Eval iteration" })
        : new WebRouteError(
            503,
            ErrorCode.INTERNAL_ERROR,
            "Could not confirm billing with MCPJam, so this eval did not run. Try again in a few minutes.",
            { code: "platform_fee_unavailable" },
          ));
  if (!refusal || refusal.status >= 500)
    logger.error("[evals] Failed to create iteration:", error);
  if (refusal) return refusal;
  if (params.namedHostId || params.runtimeVenue)
    return new Error(
      "Could not record this client's eval iteration. Update the backend before running it.",
      { cause: error },
    );
  if (params.requireRecord)
    return new HarnessIterationRecordError(
      `${HARNESS_ITERATION_RECORD_REQUIRED}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  return undefined;
}

/**
 * Settle rows a multi-run quick run already created before a later row was
 * refused, so none stays `running` with its quota spent and nothing to finish
 * it. Each row is settled independently: one failed write leaves the others.
 */
export async function settlePrecreatedIterations(
  convexClient: ConvexHttpClient,
  iterationIds: readonly (string | undefined)[],
  message: string,
): Promise<void> {
  for (const iterationId of iterationIds) {
    if (!iterationId) continue;
    try {
      await convexClient.action(UPDATE_TEST_ITERATION, {
        iterationId,
        status: "skipped",
        result: "failed",
        actualToolCalls: [],
        tokensUsed: 0,
        error: message,
      });
    } catch (error) {
      // The refusal is still returned to the caller; this row stays running.
      logger.warn("[evals] Failed to settle a pre-created iteration", {
        iterationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
