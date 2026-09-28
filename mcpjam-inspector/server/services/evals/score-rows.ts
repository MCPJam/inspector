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
import { evaluateToolCalls } from "@mcpjam/sdk/matchers";
import { resolveExtrasCap } from "@/shared/eval-matching";
import type { AgentActivityAssessment } from "./agent-activity.js";
import {
  HOSTED_AGENT_ACTIVITY_SCORER_ID,
  HOSTED_JUDGE_SCORER_ID,
  HOSTED_TOOL_ARGUMENTS_SCORER_ID,
  HOSTED_TOOL_MATCH_SCORER_ID,
  buildHostedEvaluationConfig,
  hostedCriterionId,
  hostedRubricCheckScorerId,
  type HostedRubricCheckDefinitionInput,
  type HostedScoreDefinitionInputs,
} from "./score-definitions.js";
import { authoredRequiredRole } from "@mcpjam/sdk/contract";
import { isRequiredRole } from "@mcpjam/sdk/predicates";

/** One predicate verdict as the runner produced it. */
export type HostedPredicateResultLike = {
  predicate: Predicate;
  passed: boolean;
  reason?: string;
  scope?: PredicateScope;
  /**
   * `"error"` ⇒ the check could not be scored. Absent ⇒ `"scored"`.
   *
   * The row still carries `passed: false` (the field is required on the wire),
   * so a reader that ignores this projects an unmeasured check as a 0 — a
   * defect on the dashboard nobody observed, and a failed trial if the check
   * gates.
   */
  status?: "scored" | "error";
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
  /** Absent on the first pass; present on the judge second pass. */
  rubricChecksVerdict?: HostedRubricChecksVerdictLike;
};

const RUBRIC_CHECK_KINDS = new Set(["boolean", "choice", "score"]);

/** One question off a stored verdict, or `undefined` when it is malformed. */
type StoredRubricCheckQuestion = HostedRubricCheckDefinitionInput & {
  status: "scored" | "error" | "skipped";
  value?: number;
  error?: string;
  rationale?: string;
  evidence?: string[];
};

/**
 * The questions a stored verdict can be projected from.
 *
 * A question missing its key, kind, digest or pass line is DROPPED, not
 * guessed at: without those there is no definition to resolve a row against,
 * and inventing one would put a scorer in the snapshot that nobody asked. An
 * unknown status is kept as an error row, so it cannot vanish silently.
 */
export function rubricCheckQuestionsFrom(
  verdict: HostedRubricChecksVerdictLike | undefined,
): StoredRubricCheckQuestion[] {
  if (!verdict || !Array.isArray(verdict.questions)) return [];
  const templateVersion = isFiniteNumber(verdict.templateVersion)
    ? verdict.templateVersion
    : undefined;
  const templateHash =
    typeof verdict.templateHash === "string" ? verdict.templateHash : undefined;
  const seen = new Set<string>();
  const out: StoredRubricCheckQuestion[] = [];
  for (const raw of verdict.questions) {
    if (typeof raw !== "object" || raw === null) continue;
    const q = raw as Record<string, unknown>;
    if (
      typeof q.key !== "string" ||
      !/^[cq]:[A-Za-z0-9_-]{1,64}$/.test(q.key) ||
      seen.has(q.key) ||
      typeof q.kind !== "string" ||
      !RUBRIC_CHECK_KINDS.has(q.kind) ||
      typeof q.contentDigest !== "string" ||
      q.contentDigest.length === 0 ||
      !isFiniteNumber(q.passThreshold)
    ) {
      continue;
    }
    seen.add(q.key);
    const status =
      q.status === "scored" || q.status === "skipped" ? q.status : "error";
    out.push({
      key: q.key,
      kind: q.kind as StoredRubricCheckQuestion["kind"],
      label: typeof q.label === "string" ? q.label : q.key,
      contentDigest: q.contentDigest,
      passThreshold: q.passThreshold,
      ...(templateVersion !== undefined ? { templateVersion } : {}),
      ...(templateHash !== undefined ? { templateHash } : {}),
      status,
      ...(isFiniteNumber(q.value) ? { value: q.value } : {}),
      ...(typeof q.error === "string"
        ? { error: q.error }
        : q.status !== status
          ? { error: `unknown status ${JSON.stringify(q.status)}` }
          : {}),
      ...(typeof q.rationale === "string" ? { rationale: q.rationale } : {}),
      ...(Array.isArray(q.evidence)
        ? {
            evidence: q.evidence.filter(
              (entry): entry is string => typeof entry === "string",
            ),
          }
        : {}),
    });
  }
  return out;
}

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

function toolMatchDeclared(inputs: HostedScoreRowInputs): boolean {
  return Boolean(
    inputs.evaluation?.expectedToolCalls?.length || inputs.toolMatchAuthored,
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
  const rubricChecks = rubricCheckQuestionsFrom(inputs.rubricChecksVerdict);
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
    ...(toolMatchDeclared(inputs)
      ? {
          toolMatch: {
            ...(inputs.matchOptions ? { matchOptions: inputs.matchOptions } : {}),
            ...(inputs.isNegativeTest ? { isNegativeTest: true } : {}),
          },
        }
      : {}),
    // Its arguments half, on the same precondition, and only where arguments
    // are compared at all. A negative case expects no call to compare.
    ...(toolMatchDeclared(inputs) &&
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
    // arguments half, so the matcher's own verdict is the selection verdict.
    const selection = toolSelectionOutcome(
      inputs.evaluation,
      inputs.matchOptions,
    );
    rows.push(
      fromCriterionResult(toolMatchDefinition, {
        criterionId: HOSTED_TOOL_MATCH_SCORER_ID,
        ...(inputs.isNegativeTest
          ? {
              passed: inputs.evaluation.passed === true,
              reason:
                inputs.evaluation.passed === true
                  ? "no tool was called, as the case expects"
                  : `${
                      inputs.evaluation.unexpected?.length ?? 0
                    } tool call(s) made where the case expects none`,
            }
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
  for (const question of rubricCheckQuestionsFrom(rubricVerdict)) {
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

  return rows;
}

/** The turns the matcher graded; the evaluation itself when it has none. */
function matcherTurns(
  evaluation: HostedEvaluationLike,
): readonly HostedMatcherTurnLike[] {
  return evaluation.promptSummaries?.length
    ? evaluation.promptSummaries
    : [evaluation];
}

export type ToolSelectionOutcome = {
  passed: boolean;
  missing: number;
  /** Extra calls in the turns that went past the cap. */
  extrasOverCap: number;
  cap: number | null;
};

/**
 * `toolCalls:match` (v3): per turn, no expected call missing and no more
 * extra calls than `maxExtraToolCalls` allows.
 *
 * Read off the matcher's OWN lists, never re-matched: a same-name call with
 * the wrong arguments is paired by the matcher and reported as an argument
 * mismatch, not as missing, so it lands on `toolCalls:arguments` and leaves
 * this verdict alone. Order folds in through the same lists — a strict or
 * superset miss leaves the expected call unpaired.
 */
export function toolSelectionOutcome(
  evaluation: HostedEvaluationLike,
  matchOptions: Record<string, unknown> | undefined,
): ToolSelectionOutcome {
  const cap = resolveExtrasCap(matchOptions);
  let missing = 0;
  let extrasOverCap = 0;
  for (const turn of matcherTurns(evaluation)) {
    missing += turn.missing?.length ?? 0;
    const extras = turn.unexpected?.length ?? 0;
    if (cap !== null && extras > cap) extrasOverCap += extras;
  }
  return {
    passed: missing === 0 && extrasOverCap === 0,
    missing,
    extrasOverCap,
    cap,
  };
}

/** Bounded, content-free summary of the selection verdict. Counts only. */
function describeToolSelection(outcome: ToolSelectionOutcome): string {
  if (outcome.passed) return "every expected tool was called";
  const parts: string[] = [];
  if (outcome.missing > 0) parts.push(`${outcome.missing} missing`);
  if (outcome.extrasOverCap > 0) {
    parts.push(
      `${outcome.extrasOverCap} unexpected (at most ${outcome.cap} allowed per turn)`,
    );
  }
  return `tool selection unmet: ${parts.join(", ")}`;
}

type ArgumentMismatchLike = {
  toolName?: unknown;
  expectedArgs?: unknown;
  actualArgs?: unknown;
};

export type ToolArgumentsOutcome = {
  /** Expected calls the matcher paired with a call, rightly or wrongly. */
  compared: number;
  mismatches: Array<{ turn?: number; toolName: string; keys: string[] }>;
};

/**
 * `toolCalls:arguments`: every expected call the matcher paired with an actual
 * one was made with the expected arguments.
 *
 * The verdict is the matcher's own `argumentMismatches`. The argument NAMES
 * each mismatch reports are recovered only for the reason line, and through
 * the same matcher, one expected key at a time, so a placeholder like
 * `"string"` means here what it meant there.
 */
export function toolArgumentsOutcome(
  evaluation: HostedEvaluationLike,
  matchOptions: Record<string, unknown> | undefined,
): ToolArgumentsOutcome {
  const turns = matcherTurns(evaluation);
  const numbered = turns.length > 1;
  let compared = 0;
  const mismatches: ToolArgumentsOutcome["mismatches"] = [];
  for (const turn of turns) {
    compared += Math.max(
      0,
      (turn.expectedToolCalls?.length ?? 0) - (turn.missing?.length ?? 0),
    );
    for (const raw of turn.argumentMismatches ?? []) {
      const mismatch = (raw ?? {}) as ArgumentMismatchLike;
      const toolName =
        typeof mismatch.toolName === "string" ? mismatch.toolName : "a tool";
      mismatches.push({
        ...(numbered && typeof turn.promptIndex === "number"
          ? { turn: turn.promptIndex + 1 }
          : {}),
        toolName,
        keys: mismatchedKeys(mismatch, matchOptions),
      });
    }
  }
  // A mismatch is itself a compared call; count it even when the turn did
  // not report its expectations.
  return { compared: Math.max(compared, mismatches.length), mismatches };
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The argument names that differ, by the matcher's own rules. Names only. */
function mismatchedKeys(
  mismatch: ArgumentMismatchLike,
  matchOptions: Record<string, unknown> | undefined,
): string[] {
  const expected = recordOf(mismatch.expectedArgs);
  const actual = recordOf(mismatch.actualArgs);
  const exact = matchOptions?.argumentMatching === "exact";
  const keys = exact
    ? [...new Set([...Object.keys(expected), ...Object.keys(actual)])]
    : Object.keys(expected);
  return keys
    .filter((key) => {
      const one = (args: Record<string, unknown>) =>
        key in args ? { [key]: args[key] } : {};
      return (
        evaluateToolCalls(
          [{ toolName: "t", arguments: one(expected) }],
          [{ toolName: "t", arguments: one(actual) }],
          { argumentMatching: exact ? "exact" : "partial" },
        ).argumentMismatches.length > 0
      );
    })
    .sort();
}

const MAX_NAMED_MISMATCHES = 3;

/** Names the tool and the argument, never a value: values can be anything. */
function describeToolArguments(outcome: ToolArgumentsOutcome): string {
  if (outcome.mismatches.length === 0) {
    return outcome.compared === 0
      ? "no expected call was matched, so there were no arguments to compare"
      : "every expected tool was called with the expected arguments";
  }
  const named = outcome.mismatches
    .slice(0, MAX_NAMED_MISMATCHES)
    .map(({ turn, toolName, keys }) => {
      const where = turn !== undefined ? `turn ${turn}: ` : "";
      const names = keys.map((key) => `\`${key}\``).join(", ");
      const what =
        keys.length === 0
          ? "different arguments"
          : keys.length === 1
            ? `a different ${names}`
            : `different ${names}`;
      return `${where}\`${toolName}\` was called with ${what} than expected`;
    });
  const rest = outcome.mismatches.length - named.length;
  return rest > 0 ? `${named.join("; ")}; and ${rest} more` : named.join("; ");
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
