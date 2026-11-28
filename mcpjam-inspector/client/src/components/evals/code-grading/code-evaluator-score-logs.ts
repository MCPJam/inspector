/**
 * Code evaluator rows on an iteration's scorecard (EFTW-90). A run scores
 * each evaluator as a `code:<id>` row in `metadata.scores`, and keeps each
 * one's output tail beside the rows, in `metadata.codeEvaluatorLogs` keyed by
 * that scorer id: a row's evidence holds only a line of it.
 */
import type { CodeEvaluatorInput } from "@mcpjam/sdk/contract";

const CODE_SCORER_PREFIX = "code:";

export type CodeEvaluatorLog = {
  output: string;
  /** From the run's frozen evaluators; absent when the run isn't at hand. */
  fileName?: string;
};

export function isCodeScorerId(scorerId: string): boolean {
  return scorerId.startsWith(CODE_SCORER_PREFIX);
}

/**
 * Each code evaluator's logs by scorer id, named with its file from the
 * evaluators the run froze. Read defensively, like the score rows: a
 * malformed entry is dropped, not shown.
 */
export function parseCodeEvaluatorLogs(
  metadata: unknown,
  frozen: readonly Pick<CodeEvaluatorInput, "id" | "fileName">[] = [],
): Record<string, CodeEvaluatorLog> {
  const logs =
    metadata && typeof metadata === "object"
      ? (metadata as { codeEvaluatorLogs?: unknown }).codeEvaluatorLogs
      : undefined;
  if (!logs || typeof logs !== "object") return {};
  const out: Record<string, CodeEvaluatorLog> = {};
  for (const [scorerId, entry] of Object.entries(logs)) {
    const output =
      entry && typeof entry === "object"
        ? (entry as { output?: unknown }).output
        : undefined;
    if (!isCodeScorerId(scorerId) || typeof output !== "string") continue;
    const id = scorerId.slice(CODE_SCORER_PREFIX.length);
    const fileName = frozen.find((evaluator) => evaluator.id === id)?.fileName;
    out[scorerId] = { output, ...(fileName ? { fileName } : {}) };
  }
  return out;
}
