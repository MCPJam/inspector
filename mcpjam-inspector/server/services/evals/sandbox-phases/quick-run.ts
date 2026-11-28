/**
 * Quick runs and code grading (EFTW-90, amendment P2). A quick run (Run or
 * Compare on one case in the editor) has no suite run: nothing is frozen, and
 * there is no run for a script or grading box to belong to. So a suite whose
 * iterations need one is refused, and its Advisory code evaluators are
 * declared Not run on the quick run's iteration.
 *
 * Run setup and run cleanup belong to a suite run, so they don't block a
 * quick run.
 */
import type { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { logger } from "../../../utils/logger.js";
import type { CodeGradingResult } from "./code-score-family.js";
import {
  EMPTY_CODE_GRADING,
  hasRequiredCodeEvaluator,
  readFrozenCodeGrading,
  type FrozenCodeGrading,
} from "./frozen-config.js";

export const QUICK_RUN_NOT_RUN =
  "Not run in a quick run. Run the case from its suite to grade it.";

const GET_SUITE = makeFunctionReference<"query">("testSuites:getTestSuite");

/** Why a quick run of a case in this suite is refused, or `undefined`. */
export function quickRunCodeGradingRefusal(
  config: FrozenCodeGrading,
): string | undefined {
  const needs = [
    ...(config.scripts.iterationSetup || config.scripts.iterationCleanup
      ? ["iteration setup and cleanup scripts"]
      : []),
    ...(hasRequiredCodeEvaluator(config) ? ["Required code evaluators"] : []),
  ];
  return needs.length
    ? `Quick runs can't run this suite's ${needs.join(" or ")}. Run the case from its suite.`
    : undefined;
}

/** Every evaluator declared, none run: what a quick run's iteration records. */
export function quickRunCodeGrading(
  config: FrozenCodeGrading,
): CodeGradingResult | undefined {
  return config.codeEvaluators.length
    ? {
        evaluators: config.codeEvaluators,
        outcomes: {},
        notRun: QUICK_RUN_NOT_RUN,
      }
    : undefined;
}

/**
 * The suite's fields as they are now. A read that fails counts as none, like
 * the quick run's other suite settings: the case still runs.
 */
export async function loadSuiteCodeGrading(
  convexClient: Pick<ConvexHttpClient, "query">,
  suiteId: string | undefined,
): Promise<FrozenCodeGrading> {
  if (!suiteId) return EMPTY_CODE_GRADING;
  try {
    return readFrozenCodeGrading(
      await convexClient.query(GET_SUITE, { suiteId }),
    );
  } catch (error) {
    logger.warn("[evals] could not read the suite's code evaluators", {
      suiteId,
      error: error instanceof Error ? error.message : String(error),
    });
    return EMPTY_CODE_GRADING;
  }
}
