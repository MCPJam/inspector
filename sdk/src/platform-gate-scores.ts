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
  EvaluationConfigSnapshot,
  ResolvedScoreDefinition,
  ScoreDefinition,
  ScoreResult,
} from "./contract/types.js";
import type { EvalTraceInput } from "./eval-reporting-types.js";
import {
  fromLegacyTestOutcome,
  legacyTestScoreDefinition,
} from "./contract/adapters.js";
import {
  buildEvaluationConfigSnapshot,
  definitionHash,
} from "./contract/derive.js";
import { scoresPassed } from "./scorers/run.js";

/** Both ids, whatever their role: reserved against custom evaluators. */
export const PLATFORM_GATE_SCORER_IDS = [
  TOOL_EXECUTION_SCORER_ID,
  ITERATION_ERROR_SCORER_ID,
] as const;

/** Whether a run graded this iteration with the platform rows. */
export function hasPlatformGateRows(iteration: {
  scores?: ReadonlyArray<{ scorerId: string }>;
}): boolean {
  return (
    iteration.scores?.some(
      (row) => row.scorerId === TOOL_EXECUTION_SCORER_ID
    ) ?? false
  );
}

/**
 * Whether an iteration without platform rows would upload a failure next to
 * score rows that derive a pass. That happens when the pre-platform check
 * fails it on a tool or iteration error that none of its rows record; the
 * upload then leaves those rows out rather than contradict its own verdict.
 */
export function legacyRowsContradictVerdict(
  iteration: { scores?: ScoreResult[] },
  passed: boolean,
  evaluationConfig: EvaluationConfigSnapshot | undefined
): boolean {
  if (passed || !evaluationConfig || !iteration.scores?.length) return false;
  if (hasPlatformGateRows(iteration)) return false;
  return scoresPassed(iteration.scores, evaluationConfig.definitions);
}

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
 * attached in `metadata.scores` / `metadata.evaluationConfig` are kept and
 * count toward the verdict too, except rows for these built-in checks: those
 * are always recomputed from this call's inputs, so metadata carried over from
 * an earlier conversion can't vouch for this one. An attached built-in
 * definition with a different policy is refused.
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
  const builtIn = buildEvaluationConfigSnapshot([
    legacyTestScoreDefinition(),
    ...platformGateDefinitions(input.failOnToolError),
  ]).definitions;
  const builtInById = new Map(
    builtIn.map((definition) => [definition.scorerId, definition])
  );
  const attachedDefinitions: ResolvedScoreDefinition[] =
    typeof callerConfig === "object" &&
    callerConfig !== null &&
    "definitions" in callerConfig &&
    Array.isArray(callerConfig.definitions)
      ? callerConfig.definitions
      : [];
  for (const attached of attachedDefinitions) {
    const own = builtInById.get(attached.scorerId);
    if (own && definitionHash(own) !== definitionHash(attached)) {
      throw new Error(
        `metadata.evaluationConfig declares "${attached.scorerId}" with a different policy than this call. Remove it from the metadata, or pass the same failOnToolError it was built with.`
      );
    }
  }
  const callerDefinitions = attachedDefinitions.filter(
    (definition) => !builtInById.has(definition.scorerId)
  );
  const callerRows: ScoreResult[] = (
    Array.isArray(callerScores) ? callerScores : []
  ).filter((row) => !builtInById.has(row.scorerId));
  const config = buildEvaluationConfigSnapshot([
    ...callerDefinitions,
    ...builtIn,
  ]);
  const definitionFor = (scorerId: string): ResolvedScoreDefinition =>
    builtInById.get(scorerId)!;
  const scores = [
    ...callerRows,
    fromLegacyTestOutcome(
      definitionFor(legacyTestScoreDefinition().scorerId),
      input.passed
    ),
    ...platformGateScores(definitionFor, {
      trace: input.trace,
      iterationError: input.iterationError,
    }),
  ];
  return {
    passed: scoresPassed(scores, config.definitions),
    metadata: { ...metadata, scores, evaluationConfig: config },
  };
}
