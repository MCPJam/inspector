/**
 * The platform's per-iteration checks, as score rows, for SDK runs.
 *
 * `failOnToolError` decides each row's role, never whether the row exists:
 * the definitions are declared on every iteration so the evaluation config is
 * identical across a run, and the verdict stays `scoresPassed(rows)`.
 */
import {
  ITERATION_ERROR_SCORER_ID,
  TOOL_EXECUTION_SCORER_ID,
  iterationErrorScoreDefinition,
  iterationErrorScoreResult,
  toolExecutionScoreDefinition,
  toolExecutionScoreResult,
} from "./contract/platform-gates.js";
import type {
  ResolvedScoreDefinition,
  ScoreDefinition,
  ScoreResult,
} from "./contract/types.js";
import type { EvalTraceInput } from "./eval-reporting-types.js";
import {
  fromLegacyTestOutcome,
  legacyTestScoreDefinition,
} from "./contract/adapters.js";
import { buildEvaluationConfigSnapshot } from "./contract/derive.js";
import { scoresPassed } from "./scorers/run.js";

/** Both ids, whatever their role: reserved against custom evaluators. */
export const PLATFORM_GATE_SCORER_IDS = [
  TOOL_EXECUTION_SCORER_ID,
  ITERATION_ERROR_SCORER_ID,
] as const;

/**
 * The SDK's platform definitions. Tool errors and iteration errors are gating
 * unless the run sets `failOnToolError: false`, which is what the upload
 * applied before these checks had rows.
 */
export function platformGateDefinitions(
  failOnToolError: boolean | undefined
): ScoreDefinition[] {
  const gating = failOnToolError !== false;
  return [
    toolExecutionScoreDefinition({ gating }),
    iterationErrorScoreDefinition({ gating }),
  ];
}

/** One row per platform definition, read from what the upload sends. */
export function platformGateScores(
  definitionFor: (scorerId: string) => ResolvedScoreDefinition,
  input: { trace: EvalTraceInput | undefined; iterationError?: string }
): ScoreResult[] {
  return [
    toolExecutionScoreResult(definitionFor(TOOL_EXECUTION_SCORER_ID), {
      trace: input.trace,
    }),
    iterationErrorScoreResult(
      definitionFor(ITERATION_ERROR_SCORER_ID),
      input.iterationError
    ),
  ];
}

/**
 * Rows and verdict for an upload that starts from the caller's own pass/fail
 * (`promptsToEvalResult`, `PromptResult.toEvalResult`).
 *
 * The caller's boolean becomes the `test()` row, the platform checks add
 * theirs, and `passed` is `scoresPassed` over all of them. Rows the caller
 * already attached in `metadata.scores` / `metadata.evaluationConfig` are kept
 * and count toward the verdict too.
 */
export function gradeCallerVerdict(input: {
  passed: boolean;
  trace: EvalTraceInput | undefined;
  iterationError: string | undefined;
  failOnToolError: boolean | undefined;
  metadata: Record<string, unknown> | undefined;
}): { passed: boolean; metadata: Record<string, unknown> } {
  const metadata = input.metadata ?? {};
  const callerScores = metadata.scores;
  const callerConfig = metadata.evaluationConfig;
  if ((callerScores === undefined) !== (callerConfig === undefined)) {
    throw new Error(
      "metadata.scores and metadata.evaluationConfig must be passed together: a score row is read through its definition."
    );
  }
  const callerDefinitions: ResolvedScoreDefinition[] =
    typeof callerConfig === "object" &&
    callerConfig !== null &&
    "definitions" in callerConfig &&
    Array.isArray(callerConfig.definitions)
      ? callerConfig.definitions
      : [];
  const callerRows: ScoreResult[] = Array.isArray(callerScores)
    ? callerScores
    : [];
  const taken = new Set(callerDefinitions.map((entry) => entry.scorerId));
  const ownDefinitions = [
    legacyTestScoreDefinition(),
    ...platformGateDefinitions(input.failOnToolError),
  ].filter((definition) => !taken.has(definition.scorerId));
  const config = buildEvaluationConfigSnapshot([
    ...callerDefinitions,
    ...ownDefinitions,
  ]);
  const byId = new Map(
    config.definitions.map((definition) => [definition.scorerId, definition])
  );
  const definitionFor = (scorerId: string): ResolvedScoreDefinition =>
    byId.get(scorerId)!;
  const ownIds = new Set(ownDefinitions.map((entry) => entry.scorerId));
  const ownRows = [
    fromLegacyTestOutcome(
      definitionFor(legacyTestScoreDefinition().scorerId),
      input.passed
    ),
    ...platformGateScores(definitionFor, {
      trace: input.trace,
      iterationError: input.iterationError,
    }),
  ].filter((row) => ownIds.has(row.scorerId));
  const scores = [...callerRows, ...ownRows];
  return {
    passed: scoresPassed(scores, config.definitions),
    metadata: { ...metadata, scores, evaluationConfig: config },
  };
}
