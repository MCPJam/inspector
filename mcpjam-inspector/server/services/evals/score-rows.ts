/**
 * Score rows for one hosted iteration — the projection, not a second grader.
 *
 * Pure, and deliberately arithmetic-free: every row is produced by the SDK's
 * `fromCriterionResult` / `fromGoalCompletionCase`, which route through
 * `finalizeScoreResult`. That is what keeps a hosted row and an SDK row
 * comparable, and it is also why an out-of-range judge score becomes
 * `status: "error"` here rather than a clamped value — the finalizer refuses to
 * clamp, and nothing in this module is allowed to "fix" that.
 *
 * The legacy verdict is untouched. `buildEvalIterationVerdict`'s `passed` stays
 * the sole authority in every mode; these rows are an additional VIEW of the
 * same evaluation, which is why they cannot disagree with it.
 */

import {
  allGatingScorersPassed,
  errorScoreResult,
  fromCriterionResult,
  fromGoalCompletionCase,
  notApplicableScoreResult,
  skippedScoreResult,
  type EvaluationConfigSnapshot,
  type ResolvedScoreDefinition,
  type ScoreResult,
} from "@mcpjam/sdk/contract";
import type { Predicate, PredicateScope } from "@mcpjam/sdk/predicates";
import {
  HOSTED_JUDGE_SCORER_ID,
  HOSTED_TOOL_MATCH_SCORER_ID,
  buildHostedEvaluationConfig,
  hostedCriterionId,
  type HostedScoreDefinitionInputs,
} from "./score-definitions.js";

/** One predicate verdict as the runner produced it. */
export type HostedPredicateResultLike = {
  predicate: Predicate;
  passed: boolean;
  reason?: string;
  scope?: PredicateScope;
};

/** The tool-call matcher's verdict, as it lands on the evaluation. */
export type HostedEvaluationLike = {
  passed?: boolean;
  expectedToolCalls?: readonly unknown[];
  missing?: readonly unknown[];
  unexpected?: readonly unknown[];
  argumentMismatches?: readonly unknown[];
};

/** `metadata.judgeVerdict`, written server-side by `saveGoalCompletion` (W2). */
export type HostedJudgeVerdictLike = {
  score?: unknown;
  threshold?: unknown;
  partialFloor?: unknown;
  status?: unknown;
  verdict?: unknown;
  judgeTemplateVersion?: unknown;
  judgeTemplateHash?: unknown;
  model?: unknown;
  error?: unknown;
};

export type HostedScoreRowInputs = {
  predicateResults?: readonly HostedPredicateResultLike[];
  evaluation?: HostedEvaluationLike;
  matchOptions?: Record<string, unknown>;
  isNegativeTest?: boolean;
  /** Absent on the first pass; present on the judge second pass. */
  judgeVerdict?: HostedJudgeVerdictLike;
  objectiveScoreCap?: number;
  /**
   * "This case authored tool-call expectations", stated WITHOUT the matcher's
   * evidence for them.
   *
   * The definition and the row have genuinely different preconditions, and
   * coupling them to one field is what made the second pass drop the
   * `toolCalls:match` DEFINITION from its config: it has the authored case but
   * not the matcher output, so `evaluation` is absent and the definition went
   * with it — while the first pass's row, merged by `scorerId` on the backend,
   * survived and became unjoinable.
   *
   * Only the DEFINITION reads this. The row still requires `evaluation`,
   * because a row is a claim about what the matcher found and this pass has
   * not run it.
   */
  toolMatchAuthored?: boolean;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** A judge that produced a number to project. */
function judgeIsScored(verdict: HostedJudgeVerdictLike): boolean {
  return verdict.status === undefined || verdict.status === "scored";
}

/**
 * A judge that ran but produced no number, in the contract's own vocabulary.
 *
 * These are EVIDENCE OF ABSENCE and are projected as such rather than dropped:
 * B4 validity reads a missing row as "this scorer was never measured", which is
 * indistinguishable from "this iteration had no such scorer at all". Writing the
 * row keeps that distinction, and because it carries `error`/`skipped`/
 * `not_applicable` instead of a value, it can never gate anything.
 */
function judgeAbsenceStatus(
  verdict: HostedJudgeVerdictLike
): "error" | "skipped" | "not_applicable" | undefined {
  return verdict.status === "error" ||
    verdict.status === "skipped" ||
    verdict.status === "not_applicable"
    ? verdict.status
    : undefined;
}

/**
 * The definition inputs implied by one iteration's evidence — shared by the
 * config snapshot and the rows so the two can never describe different scorers.
 */
export function hostedScoreDefinitionInputs(
  inputs: HostedScoreRowInputs
): HostedScoreDefinitionInputs {
  const judge = inputs.judgeVerdict;
  return {
    ...(inputs.predicateResults?.length
      ? {
          predicates: inputs.predicateResults.map((result) => ({
            predicate: result.predicate,
            ...(result.scope ? { scope: result.scope } : {}),
          })),
        }
      : {}),
    // A case that authored no expectations has no tool-match scorer at all,
    // rather than a vacuously passing one. `toolMatchAuthored` says the same
    // thing for a caller holding the authored case but not the matcher's
    // output — see the field's note.
    ...(inputs.evaluation?.expectedToolCalls?.length || inputs.toolMatchAuthored
      ? {
          toolMatch: {
            ...(inputs.matchOptions ? { matchOptions: inputs.matchOptions } : {}),
            ...(inputs.isNegativeTest ? { isNegativeTest: true } : {}),
          },
        }
      : {}),
    // Any judge verdict still declares its scorer, so long as the verdict
    // carries the threshold that defines it. This includes unknown statuses:
    // they must project as an error row rather than disappearing. Without a
    // threshold there is no definition to resolve against and inventing one
    // would put a fabricated scorer in the snapshot.
    ...(judge &&
    isFiniteNumber(judge.threshold)
      ? {
          judge: {
            threshold: judge.threshold,
            ...(isFiniteNumber(judge.partialFloor)
              ? { partialFloor: judge.partialFloor }
              : {}),
            ...(isFiniteNumber(judge.judgeTemplateVersion)
              ? { judgeTemplateVersion: judge.judgeTemplateVersion }
              : {}),
            ...(typeof judge.judgeTemplateHash === "string"
              ? { judgeTemplateHash: judge.judgeTemplateHash }
              : {}),
            ...(typeof judge.model === "string" ? { model: judge.model } : {}),
            ...(isFiniteNumber(inputs.objectiveScoreCap)
              ? { objectiveScoreCap: inputs.objectiveScoreCap }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * Turn `{ predicateResults, evaluation, judgeVerdict? }` into contract rows.
 *
 * Every row resolves against a definition from the SAME snapshot the caller
 * persists, so `scorerId` joins are total; a result without a definition is
 * dropped rather than invented, because a row that cannot be joined is a row
 * whose threshold and role are unknown.
 */
export function buildHostedScoreRows(
  inputs: HostedScoreRowInputs,
  config: EvaluationConfigSnapshot
): ScoreResult[] {
  const byId = new Map<string, ResolvedScoreDefinition>(
    config.definitions.map((definition) => [definition.scorerId, definition])
  );
  const rows: ScoreResult[] = [];

  for (const result of inputs.predicateResults ?? []) {
    const criterionId = hostedCriterionId(result.predicate, result.scope);
    const definition = byId.get(`predicate:${criterionId}`);
    if (!definition) continue;
    rows.push(
      fromCriterionResult(definition, {
        criterionId,
        passed: result.passed,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.scope ? { scope: result.scope } : {}),
      })
    );
  }

  const toolMatchDefinition = byId.get(HOSTED_TOOL_MATCH_SCORER_ID);
  if (toolMatchDefinition && inputs.evaluation) {
    // The matcher already applied the case's match options (extras policy,
    // ordering, negative polarity), so its own `passed` is the criterion — this
    // must not re-derive one from `missing`/`unexpected`.
    rows.push(
      fromCriterionResult(toolMatchDefinition, {
        criterionId: HOSTED_TOOL_MATCH_SCORER_ID,
        passed: inputs.evaluation.passed === true,
        reason: describeToolMatch(inputs.evaluation),
      })
    );
  }

  const judgeDefinition = byId.get(HOSTED_JUDGE_SCORER_ID);
  const judge = inputs.judgeVerdict;
  if (judgeDefinition && judge) {
    const absence = judgeAbsenceStatus(judge);
    if (absence === "error") {
      rows.push(
        errorScoreResult(
          judgeDefinition,
          typeof judge.error === "string" && judge.error.length > 0
            ? judge.error
            : "judge reported an error"
        )
      );
    } else if (absence === "skipped") {
      rows.push(skippedScoreResult(judgeDefinition, "judge did not run"));
    } else if (absence === "not_applicable") {
      rows.push(
        notApplicableScoreResult(judgeDefinition, "judge does not apply")
      );
      // `score` is handed over UNCHANGED, including an OUT-OF-RANGE one: the
      // finalizer turns 1.4 into `status: "error"`, and clamping it here would
      // launder a broken judge into a passing row.
    } else if (judgeIsScored(judge) && typeof judge.score === "number") {
      rows.push(fromGoalCompletionCase(judgeDefinition, { score: judge.score }));
    } else if (!judgeIsScored(judge)) {
      rows.push(
        errorScoreResult(
          judgeDefinition,
          `judge reported unknown status ${JSON.stringify(judge.status)}`,
        ),
      );
    } else {
      // A verdict claiming `scored` with no number is malformed, not
      // out-of-range. Projecting the number would fabricate it; dropping the row
      // would report the scorer as absent. `error` says what actually happened.
      rows.push(
        errorScoreResult(judgeDefinition, "judge reported no numeric score")
      );
    }
  }

  return rows;
}

/** Bounded, content-free summary of the matcher's verdict. Counts only. */
function describeToolMatch(evaluation: HostedEvaluationLike): string {
  if (evaluation.passed === true) {
    return "every expected tool call was observed";
  }
  const parts: string[] = [];
  if (evaluation.missing?.length) {
    parts.push(`${evaluation.missing.length} missing`);
  }
  if (evaluation.argumentMismatches?.length) {
    parts.push(`${evaluation.argumentMismatches.length} argument mismatch(es)`);
  }
  if (evaluation.unexpected?.length) {
    parts.push(`${evaluation.unexpected.length} unexpected`);
  }
  return parts.length > 0
    ? `tool-call expectations unmet: ${parts.join(", ")}`
    : "tool-call expectations unmet";
}

/**
 * What the score rows alone would say about this iteration, for SHADOW
 * COMPARISON ONLY.
 *
 * A THIN READING of the contract's `allGatingScorersPassed`, not a second
 * implementation of it — B3b promoted the arithmetic into
 * `sdk/src/contract/derive.ts` so the deriver, the backend's verifier and this
 * comparison all count the same rows the same way. What this adds is which of
 * that function's two failure modes the SHADOW question cares about:
 *
 *   - `disagreeingScorerIds` — a gating scorer RAN and said no. A real
 *     disagreement with the boolean verdict, and the thing worth an alert.
 *   - `unresolvedScorerIds`  — a gating scorer produced no usable verdict.
 *     DELIBERATELY IGNORED here. An `error` or `skipped` row is an ABSENCE of
 *     evidence, not a failure, and reading it as one would manufacture
 *     mismatches out of unscorable criteria — the same reason `evaluateGates`
 *     treats a non-gateable score as non-gating rather than as a fail.
 *
 * The AUTHORITY path is stricter and reads `passed` off the contract function
 * directly (see `finalize-iteration`), because "we could not score this gate"
 * must not pass an iteration. The two questions genuinely differ; sharing the
 * arithmetic while differing on that one reading is the point.
 *
 * This is never persisted: its only consumer is `buildShadowMismatch`, whose
 * output is telemetry.
 */
export function shadowVerdictFromScores(
  scores: readonly ScoreResult[],
  config: EvaluationConfigSnapshot
): { passed: boolean; disagreeingScorerIds: string[] } {
  const { disagreeingScorerIds } = allGatingScorersPassed(scores, config);
  return {
    passed: disagreeingScorerIds.length === 0,
    disagreeingScorerIds,
  };
}

/** Config snapshot + rows for one hosted iteration, built from one evidence set. */
export function buildHostedScoreContract(inputs: HostedScoreRowInputs): {
  evaluationConfig: EvaluationConfigSnapshot;
  scores: ScoreResult[];
} {
  const evaluationConfig = buildHostedEvaluationConfig(
    hostedScoreDefinitionInputs(inputs)
  );
  return {
    evaluationConfig,
    scores: buildHostedScoreRows(inputs, evaluationConfig),
  };
}
