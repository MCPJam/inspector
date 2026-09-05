import {
  assembleEvalRunDecisionChain,
  projectStageDerivation,
  type EvalRunDecisionChain,
} from "@mcpjam/sdk/contract";
import type { EvalIteration } from "../types";

/**
 * Assemble a decision chain from a quick-run iteration the client already
 * holds. Uses the same projection + assembler as the server so the
 * verified/unverified/absent discriminant is not re-derived from raw
 * `metadata.stageResults`.
 */
export function chainForQuickRunIteration(
  iteration: EvalIteration,
): EvalRunDecisionChain {
  return assembleEvalRunDecisionChain({
    id: iteration._id,
    iterationNumber: iteration.iterationNumber,
    status: iteration.status,
    result: iteration.result,
    testCaseId: iteration.testCaseId,
    title: iteration.testCaseSnapshot?.title,
    expectedToolCalls: iteration.testCaseSnapshot?.expectedToolCalls,
    actualToolCalls: iteration.actualToolCalls,
    error: iteration.error,
    ...projectStageDerivation(iteration.metadata),
  });
}
