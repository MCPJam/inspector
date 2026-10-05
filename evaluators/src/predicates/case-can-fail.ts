/**
 * "Can this case fail?" — the vacuity lint.
 *
 * A case whose only gating checks are things like `noToolErrors` passes when
 * the agent does NOTHING: no calls means no errors, and an empty answer
 * violates no ceiling. Such a case cannot catch an agent that skips the task,
 * so it is worth a warning when it is authored and a refusal when trace repair
 * rewrites a case into one.
 *
 * The method is to grade the case against the answer it should never accept:
 * an EMPTY transcript — no calls, no results, empty final text, zero usage —
 * whose evidence channels are marked fully captured, so an absence reads as a
 * measured absence rather than missing evidence. If every gating row then
 * scores a pass, nothing an agent could do would fail the case.
 *
 * Deliberately conservative: a warning that fires on a case that can fail is
 * worse than one that stays quiet, so only a row the empty transcript can
 * actually FEED counts toward "vacuous".
 *
 *   - `status` is read, not the boolean: an `error` row is "could not
 *     measure" and settles nothing either way.
 *   - Kinds whose evidence an empty transcript does not carry — widget
 *     renders, latency, the advertised tool inventory, the discovery catalog —
 *     are "can't tell", never a pass, whatever the evaluator returns for them.
 *   - A REQUIRED goal-completion judge is "can't tell": it grades the answer
 *     with a model, and a gating judge would fail an empty one.
 *   - Negative tests are out of scope: passing with no calls is their design.
 *
 * No "perfect answer" check is attempted: this says whether the case can
 * FAIL, never whether it can PASS.
 */

import { evaluatePredicates, evaluateTurnChecks } from "./evaluate.js";
import { checkRole, isRequiredRole } from "./policy.js";
import type {
  IterationTranscript,
  Predicate,
  PredicateResult,
  PredicateType,
} from "./types.js";

/**
 * Kinds an empty transcript cannot feed. Their verdict on it says nothing
 * about what an agent could get away with, so they count as "can't tell".
 */
const CASE_CAN_FAIL_UNFED_KINDS = [
  // Render observations exist only where a headless browser rendered a view.
  "widgetRendered",
  "widgetRenderLatencyUnder",
  "widgetNoConsoleErrors",
  // Latency is a measurement of calls that were made.
  "toolLatencyUnder",
  // Read the advertised tool inventory, not the agent's behaviour.
  "argumentsMatchToolSchema",
  "noDestructiveToolCalled",
  "noDeprecatedToolCalled",
  // Discovery: grade the server's catalog, independent of the agent.
  "toolDescriptionsPresent",
  "toolAnnotationsPresent",
  "toolNamesUnique",
  "noDeprecatedToolExposed",
  "toolInputSchemasWellFormed",
  "toolOutputSchemasPresent",
] as const satisfies readonly PredicateType[];

function isUnfedKind(kind: string): boolean {
  return (CASE_CAN_FAIL_UNFED_KINDS as readonly string[]).includes(kind);
}

/**
 * - `can_fail` — some gating check fails on an empty answer.
 * - `vacuous` — every gating check passes on an empty answer.
 * - `cannot_tell` — nothing fails, but a gating check could not be fed.
 * - `not_applicable` — a negative test; passing on no calls is its design.
 */
export type CaseCanFailVerdict =
  "can_fail" | "vacuous" | "cannot_tell" | "not_applicable";

export interface CaseCanFailOptions {
  /**
   * Per-turn checks (non-tool-call assertions authored on a prompt turn),
   * graded through {@link evaluateTurnChecks} on the same empty transcript.
   */
  turnChecks?: ReadonlyArray<{
    promptIndex: number;
    checks: Predicate[] | undefined;
  }>;
  /**
   * Labels of gating checks graded OUTSIDE the predicate engine — widget DOM
   * assertions and interactions, a pinned tool call's evidence. The empty
   * transcript cannot feed them, so each one is "can't tell".
   */
  externalChecks?: readonly string[];
  /**
   * The role of the goal-completion judge that will grade this case, after
   * the suite's setting and the case's opt-out are layered; absent when no
   * judge runs. A required (`"required"` or `"gating"`) judge is "can't tell":
   * it fails an empty answer, but only a model can say so.
   */
  goalCompletionJudgeRole?: unknown;
  /**
   * User turns the case sends. The user's messages are not the agent's to
   * withhold, so the empty transcript still carries them. Defaults to 1.
   */
  userTurns?: number;
}

export interface CaseCanFailResult {
  verdict: CaseCanFailVerdict;
  /** `verdict === "vacuous"`, for callers that only branch on the warning. */
  vacuous: boolean;
  /** Deterministic, human-readable explanation of the verdict. */
  reason: string;
  /** Every GATING row graded on the empty transcript, case-level then per-turn. */
  results: PredicateResult[];
  /**
   * Gating checks counted as "can't tell": unfed kinds, error rows, external
   * checks and a required judge.
   */
  unmeasured: string[];
}

/** Label of a required goal-completion judge in {@link CaseCanFailResult.unmeasured}. */
export const REQUIRED_GOAL_COMPLETION_JUDGE_LABEL =
  "required goal-completion judge";

/** The answer a case must never accept, with every channel marked captured. */
export function buildEmptyAnswerTranscript(userTurns = 1): IterationTranscript {
  return {
    toolCalls: [],
    toolErrors: [],
    finalAssistantMessage: "",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: Math.max(0, Math.floor(userTurns)),
    toolResults: [],
    toolCallTimings: [],
    toolInventory: [],
    toolDeclarations: [],
    capture: {
      toolResults: "complete",
      toolCallTimings: "complete",
      toolInventory: "complete",
      toolDeclarations: "complete",
    },
  };
}

function isGating(row: PredicateResult): boolean {
  return checkRole(row.predicate) !== "advisory";
}

function isScored(row: PredicateResult): boolean {
  return (row.status ?? "scored") === "scored";
}

function describeRow(row: PredicateResult): string {
  const scope =
    row.scope?.kind === "turn" ? ` (turn ${row.scope.promptIndex + 1})` : "";
  return `${row.predicate.type}${scope}`;
}

/**
 * Can this case fail? Grades the case's checks against an empty answer.
 *
 * @param effectivePredicates The case-level checks AS THE RUNNER GRADES THEM —
 *   suite defaults merged with the case's own envelope (the inspector's
 *   `resolveCaseSuccessPredicates`). A case's own list alone misses inherited
 *   defaults.
 * @param expectedToolCalls The tool-call expectations the matcher grades. A
 *   positive case with any fails on an empty answer.
 * @param isNegativeTest Negative tests are `not_applicable`.
 */
export function checkCaseCanFail(
  effectivePredicates: Predicate[] | undefined,
  expectedToolCalls: readonly unknown[] | undefined,
  isNegativeTest: boolean | undefined,
  options: CaseCanFailOptions = {},
): CaseCanFailResult {
  if (isNegativeTest === true) {
    return {
      verdict: "not_applicable",
      vacuous: false,
      reason: "negative test: passing with no tool calls is its design",
      results: [],
      unmeasured: [],
    };
  }

  const transcript = buildEmptyAnswerTranscript(options.userTurns ?? 1);
  const results = [
    ...evaluatePredicates(transcript, effectivePredicates ?? []),
    ...evaluateTurnChecks(
      (options.turnChecks ?? []).map((turn) => ({
        promptIndex: turn.promptIndex,
        checks: turn.checks,
        transcript,
      })),
    ),
  ].filter(isGating);

  const expectedCount = Array.isArray(expectedToolCalls)
    ? expectedToolCalls.length
    : 0;
  if (expectedCount > 0) {
    return {
      verdict: "can_fail",
      vacuous: false,
      reason: `an empty answer misses ${expectedCount} expected tool call(s)`,
      results,
      unmeasured: [],
    };
  }

  const failing = results.filter(
    (row) => !isUnfedKind(row.predicate.type) && isScored(row) && !row.passed,
  );
  if (failing.length > 0) {
    return {
      verdict: "can_fail",
      vacuous: false,
      reason: `an empty answer fails ${failing.map(describeRow).join(", ")}`,
      results,
      unmeasured: [],
    };
  }

  const unmeasured = [
    ...results
      .filter((row) => isUnfedKind(row.predicate.type) || !isScored(row))
      .map(describeRow),
    ...(options.externalChecks ?? []),
    ...(isRequiredRole(options.goalCompletionJudgeRole)
      ? [REQUIRED_GOAL_COMPLETION_JUDGE_LABEL]
      : []),
  ];
  if (unmeasured.length > 0) {
    return {
      verdict: "cannot_tell",
      vacuous: false,
      reason: `no check fails on an empty answer, but ${unmeasured.join(
        ", ",
      )} cannot be graded without one`,
      results,
      unmeasured,
    };
  }

  return {
    verdict: "vacuous",
    vacuous: true,
    reason:
      results.length === 0
        ? "the case has no gating check and no expected tool call, so an empty answer passes"
        : `an empty answer passes every gating check (${results
            .map(describeRow)
            .join(", ")})`,
    results,
    unmeasured: [],
  };
}
