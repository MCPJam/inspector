import type { MultiTurnEvaluationResult } from "./types";

export function buildIterationMetadata(
  evaluation: MultiTurnEvaluationResult,
): Record<string, string | number | boolean> {
  const missingCount = evaluation.missing.length;
  const unexpectedCount = evaluation.unexpected.length;
  const argumentMismatchCount = evaluation.argumentMismatches.length;
  const mismatchCount =
    missingCount + unexpectedCount + argumentMismatchCount;

  const metadata: Record<string, string | number | boolean> = {
    turnCount: evaluation.turnCount,
    failedTurnCount: evaluation.failedTurnCount,
    missingCount,
    unexpectedCount,
    argumentMismatchCount,
    mismatchCount,
  };

  if (typeof evaluation.firstFailedTurnIndex === "number") {
    metadata.firstFailedTurnIndex = evaluation.firstFailedTurnIndex;
  }

  return metadata;
}
