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
  finalizeScoreResult,
  fromCriterionResult,
  fromGoalCompletionCase,
  notApplicableScoreResult,
  skippedScoreResult,
  type EvaluationConfigSnapshot,
  type ResolvedScoreDefinition,
  type ScoreResult,
} from "@mcpjam/sdk/contract";
import type { Predicate, PredicateScope } from "@mcpjam/sdk/predicates";
import { resolveExtrasCap } from "@/shared/eval-matching";
import { rubricCheckVerdictQuestions } from "@/shared/rubric-check-verdict";
import type { AgentActivityAssessment } from "./agent-activity.js";
import {
  customJudgeDefinitionInputs,
  customJudgeScoreRows,
  type HostedCustomJudgesVerdictLike,
} from "./custom-judge-rows.js";
import {
  hostedPlatformGateRows,
  type PlatformGateEvidence,
} from "./platform-gate-rows.js";
import {
  HOSTED_AGENT_ACTIVITY_SCORER_ID,
  HOSTED_JUDGE_SCORER_ID,
  HOSTED_TOOL_ARGUMENTS_SCORER_ID,
  HOSTED_TOOL_MATCH_SCORER_ID,
  buildHostedEvaluationConfig,
  hostedCriterionId,
  hostedRubricCheckScorerId,
  type HostedScoreDefinitionInputs,
} from "./score-definitions.js";
import {
  describeToolArguments,
  describeToolSelection,
  negativeSelection,
  toolArgumentsOutcome,
  toolSelectionOutcome,
} from "./tool-call-outcomes.js";
import {
  codeEvaluatorRows,
  type CodeGradingResult,
} from "./sandbox-phases/code-score-family.js";
import { authoredRequiredRole } from "@mcpjam/sdk/contract";
import { isRequiredRole } from "@mcpjam/sdk/predicates";

/** One predicate verdict as the runner produced it. */
export type HostedPredicateResultLike = {
  predicate: Predicate;
  passed: boolean;
  reason?: string;
  scope?: PredicateScope;
  /**
   * `"error"` ⇒ the check could not be scored. `"not_applicable"` ⇒ nothing
   * to judge; it carries `passed: true`. Absent ⇒ `"scored"`.
   *
   * The row still carries `passed: false` (the field is required on the wire),
   * so a reader that ignores this projects an unmeasured check as a 0 — a
   * defect on the dashboard nobody observed, and a failed trial if the check
   * gates.
   */
  status?: "scored" | "error" | "not_applicable";
};

/** One turn of the tool-call matcher's verdict. */
export type HostedMatcherTurnLike = {
  promptIndex?: number;
  expectedToolCalls?: readonly unknown[];
  missing?: readonly unknown[];
  unexpected?: readonly unknown[];
  argumentMismatches?: readonly unknown[];
};

/** The tool-call matcher's verdict, as it lands on the evaluation. */
export type HostedEvaluationLike = HostedMatcherTurnLike & {
  passed?: boolean;
  /**
   * Per turn. The extras cap is applied PER TURN by the matcher, so the
   * selection verdict has to read it per turn too: two turns with one extra
   * call each pass a cap of 1, and the flattened list would say two.
   */
  promptSummaries?: readonly HostedMatcherTurnLike[];
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
  /**
   * Whether this judge was allowed to DECIDE the trial, stamped by the backend
   * from the run's frozen config. `unknown` because everything on this type is:
   * these fields arrive from a database document, not from a validator.
   */
  role?: unknown;
};

/**
 * `metadata.rubricChecksVerdict`, written server-side by the goal-completion
 * job's rubric-check half. Everything is `unknown` for the same reason as the
 * judge verdict: it arrives from a database document.
 */
export type HostedRubricChecksVerdictLike = {
  status?: unknown;
  reason?: unknown;
  templateVersion?: unknown;
  templateHash?: unknown;
  /** The model that ANSWERED. Rows carry it; definitions always name Jev. */
  model?: unknown;
  decidedBy?: unknown;
  questions?: unknown;
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
  /** @see assessAgentActivity */
  agentActivity?: AgentActivityAssessment;
  /** Both absent on the first pass; present on the judge second pass. */
  rubricChecksVerdict?: HostedRubricChecksVerdictLike;
  customJudgesVerdict?: HostedCustomJudgesVerdictLike;
  /** First pass only: what the platform rows are graded from. */
  platformGates?: PlatformGateEvidence;
  codeGrading?: CodeGradingResult;
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
 * row keeps that distinction.
 *
 * WHAT SUCH A ROW DOES NOW DEPENDS ON THE DEFINITION. On an advisory judge it
 * is inert, as it always was. On a GATING judge it lights `noGatingScoreErrors`
 * and counts as an evaluator error on the backend — which is the correct
 * reading, because a gate that cannot be evaluated has not been satisfied. What
 * it still cannot do, structurally, is fail the trial by itself: the row
 * carries no `passed`, so `allGatingScorersPassed` reports it as UNRESOLVED
 * rather than failing, and the backend quarantines the trial instead of
 * grading it.
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

/** The case lists calls that should happen. */
function toolExpectationsDeclared(inputs: HostedScoreRowInputs): boolean {
  return Boolean(
    inputs.evaluation?.expectedToolCalls?.length || inputs.toolMatchAuthored,
  );
}

/**
 * A case that lists no expected call still says which calls may happen when it
 * is negative (none) or caps extra calls (at most N). The matcher fails it on
 * that claim, so it needs a `toolCalls:match` row to say why it failed.
 */
export function claimsToolSelectionWithoutExpectations(
  isNegativeTest: boolean | undefined,
  matchOptions: Record<string, unknown> | undefined,
): boolean {
  return isNegativeTest === true || resolveExtrasCap(matchOptions) !== null;
}

function toolMatchDeclared(inputs: HostedScoreRowInputs): boolean {
  if (toolExpectationsDeclared(inputs)) return true;
  // Only a caller that knows the case: the first pass has the matcher's
  // output, and the second pass states `toolMatchAuthored`. A second pass that
  // carries the stored definitions passes neither and declares nothing here.
  const knowsCase =
    inputs.evaluation !== undefined || inputs.toolMatchAuthored !== undefined;
  return (
    knowsCase &&
    claimsToolSelectionWithoutExpectations(
      inputs.isNegativeTest,
      inputs.matchOptions,
    )
  );
}

/** `argumentMatching` absent resolves to the matcher's default, `"partial"`. */
function comparesArguments(
  matchOptions: Record<string, unknown> | undefined,
): boolean {
  return matchOptions?.argumentMatching !== "ignore";
}

/**
 * The definition inputs implied by one iteration's evidence — shared by the
 * config snapshot and the rows so the two can never describe different scorers.
 */
export function hostedScoreDefinitionInputs(
  inputs: HostedScoreRowInputs
): HostedScoreDefinitionInputs {
  const judge = inputs.judgeVerdict;
  const rubricChecks = rubricCheckVerdictQuestions(inputs.rubricChecksVerdict);
  const customJudges = customJudgeDefinitionInputs(inputs.customJudgesVerdict);
  return {
    ...(customJudges.length > 0 ? { customJudges } : {}),
    ...(inputs.predicateResults?.length
      ? {
          predicates: inputs.predicateResults.map((result) => ({
            predicate: result.predicate,
            ...(result.scope ? { scope: result.scope } : {}),
          })),
        }
      : {}),
    // A case that makes no claim about its calls has no tool-match scorer at
    // all, rather than a vacuously passing one. `toolMatchAuthored` says the
    // same thing for a caller holding the authored case but not the matcher's
    // output — see the field's note.
    ...(toolMatchDeclared(inputs)
      ? {
          toolMatch: {
            ...(inputs.matchOptions ? { matchOptions: inputs.matchOptions } : {}),
            ...(inputs.isNegativeTest ? { isNegativeTest: true } : {}),
          },
        }
      : {}),
    // Its arguments half, only for a case that lists expected calls, and only
    // where arguments are compared at all. With no expected call there is no
    // argument to compare.
    ...(toolExpectationsDeclared(inputs) &&
    !inputs.isNegativeTest &&
    comparesArguments(inputs.matchOptions)
      ? {
          toolArguments: {
            ...(inputs.matchOptions
              ? { matchOptions: inputs.matchOptions }
              : {}),
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
            // BOTH spellings of the required role, and nothing else. Absent,
            // "advisory", an unknown value or the wrong case all resolve to
            // advisory: the default here decides whether a judge may fail
            // somebody's build, so it fails closed.
            //
            // The pair, not one literal: the backend stamped `"gating"` on
            // every verdict written before the rename and stamps `"required"`
            // after it, and this reads historical evidence. A comparator that
            // took one word would silently un-gate every hosted judge on one
            // side of that line.
            ...(isRequiredRole(judge.role)
              ? { role: authoredRequiredRole() }
              : {}),
          },
        }
      : {}),
    ...(inputs.agentActivity?.status === "no_agent_activity"
      ? { agentActivityFired: true }
      : {}),
    ...(inputs.platformGates
      ? {
          platformGates: {
            failOnToolError: inputs.platformGates.failOnToolError,
          },
        }
      : {}),
    ...(rubricChecks.length > 0
      ? {
          rubricChecks: rubricChecks.map(
            ({ key, kind, label, contentDigest, passThreshold, ...rest }) => ({
              key,
              kind,
              label,
              contentDigest,
              passThreshold,
              ...(rest.templateVersion !== undefined
                ? { templateVersion: rest.templateVersion }
                : {}),
              ...(rest.templateHash !== undefined
                ? { templateHash: rest.templateHash }
                : {}),
            }),
          ),
        }
      : {}),
    ...(inputs.codeGrading?.evaluators.length
      ? { codeEvaluators: inputs.codeGrading.evaluators }
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
    // A check with no evidence is an ERROR row, not a 0. The distinction is
    // load-bearing downstream: an error row carries no value, keeps the
    // scorer in `unresolvedScorerIds`, and leaves its stage `notMeasured`,
    // where a 0 would attribute a defect to the server on a measurement we
    // never took.
    if (result.status === "error") {
      rows.push(
        errorScoreResult(definition, result.reason ?? "no evidence captured", {
          ...(result.scope ? { scope: result.scope } : {}),
        })
      );
      continue;
    }
    if (result.status === "not_applicable") {
      rows.push(
        notApplicableScoreResult(definition, result.reason, {
          ...(result.scope ? { scope: result.scope } : {}),
        })
      );
      continue;
    }
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
    // SELECTION only (v3): the matcher's own per-turn `missing` and extras,
    // read against the same cap it applied. Its `passed` also folds in the
    // arguments, which are `toolCalls:arguments` now; the two rows together
    // pass exactly when it did.
    //
    // A NEGATIVE case is the exception, and only in name: "no tool should be
    // called" is a selection claim through and through, and it has no
    // arguments half. Read off the calls rather than `passed`, which the
    // failure path forces false before any call was made.
    const selection = toolSelectionOutcome(
      inputs.evaluation,
      inputs.matchOptions,
    );
    rows.push(
      fromCriterionResult(toolMatchDefinition, {
        criterionId: HOSTED_TOOL_MATCH_SCORER_ID,
        ...(inputs.isNegativeTest
          ? negativeSelection(inputs.evaluation)
          : {
              passed: selection.passed,
              reason: describeToolSelection(selection),
            }),
      })
    );
  }

  const argumentsDefinition = byId.get(HOSTED_TOOL_ARGUMENTS_SCORER_ID);
  if (argumentsDefinition && inputs.evaluation) {
    const outcome = toolArgumentsOutcome(
      inputs.evaluation,
      inputs.matchOptions,
    );
    // ALWAYS scored, never `skipped`: a gating row with no verdict is an
    // unresolved gate, and at `enforce` that is a strictness path the first
    // pass does not have (`finalize-iteration-enforce.test.ts`). With nothing
    // compared — no expected call was matched — the row passes and says why:
    // the miss is `toolCalls:match`'s to report, and failing here too would
    // count it twice. `passed` is exactly "the matcher reported no argument
    // mismatch", which is what keeps match ∧ arguments equal to its verdict.
    rows.push(
      fromCriterionResult(argumentsDefinition, {
        criterionId: HOSTED_TOOL_ARGUMENTS_SCORER_ID,
        passed: outcome.mismatches.length === 0,
        reason: describeToolArguments(outcome),
      })
    );
  }

  const activityDefinition = byId.get(HOSTED_AGENT_ACTIVITY_SCORER_ID);
  if (activityDefinition && inputs.agentActivity?.status === "no_agent_activity") {
    // An error row, not a 0: nothing was measured. The paired `passed = false`
    // lives in `buildEvalIterationVerdict`, since rows decide nothing under
    // `shadow` and `off` grading.
    rows.push(
      errorScoreResult(
        activityDefinition,
        `no_agent_activity: ${inputs.agentActivity.detail}`,
      ),
    );
  }

  if (inputs.platformGates) {
    rows.push(...hostedPlatformGateRows(byId, inputs.platformGates));
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

  // Rubric checks: one advisory row per asked question. The row carries the
  // rail that answered (`model`), while the definition always names Jev; the
  // value is handed over unchanged, so an out-of-range one finalizes to an
  // error rather than being clamped into a pass.
  const rubricVerdict = inputs.rubricChecksVerdict;
  const answeredBy =
    typeof rubricVerdict?.model === "string" && rubricVerdict.model.length > 0
      ? rubricVerdict.model
      : undefined;
  for (const question of rubricCheckVerdictQuestions(rubricVerdict)) {
    const definition = byId.get(hostedRubricCheckScorerId(question.key));
    if (!definition) continue;
    if (question.status === "skipped") {
      rows.push(
        skippedScoreResult(
          definition,
          typeof rubricVerdict?.reason === "string"
            ? `rubric checks did not run: ${rubricVerdict.reason}`
            : "rubric checks did not run",
        ),
      );
      continue;
    }
    if (question.status === "error" || question.value === undefined) {
      rows.push(
        errorScoreResult(
          definition,
          question.error ??
            (question.status === "scored"
              ? "rubric check reported no value"
              : "no_answer"),
        ),
      );
      continue;
    }
    rows.push(
      finalizeScoreResult(definition, {
        kind: "scored",
        value: question.value,
        ...(question.rationale ? { rationale: question.rationale } : {}),
        ...(question.evidence?.length ? { evidence: question.evidence } : {}),
        ...(answeredBy ? { model: answeredBy } : {}),
      }),
    );
  }

  rows.push(...customJudgeScoreRows(inputs.customJudgesVerdict, byId));
  rows.push(...codeEvaluatorRows(inputs.codeGrading, byId));
  return rows;
}

/** The turns the matcher graded; the evaluation itself when it has none. */
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
