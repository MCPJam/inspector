/**
 * The user-facing words for the eval contract's closed vocabularies.
 *
 * This module is browser-safe and intentionally has no node-only deps.
 *
 * Every enum this initiative pins is a WIRE spelling — `userValue`,
 * `argumentMismatch`, `evaluatorErrorRateAboveMaximum`. Those are correct on
 * the wire and wrong in front of a human, and until now each surface invented
 * its own rendering: the CLI printed the raw enum, the HTML report printed the
 * raw enum, and a future UI would have invented a third spelling. One map per
 * vocabulary, in one place, is what makes "first failed stage: User value"
 * mean the same thing in a terminal, in a CI artifact and in a browser.
 *
 * ── Why these are `satisfies Record<Enum, string>` ───────────────────────────
 *
 * Every map below is total over its vocabulary and says so to the compiler.
 * Adding a stage reason, a failure category or a verdict reason to the contract
 * therefore breaks THIS FILE until somebody writes the words a human reads —
 * which is the point. The alternative, a lookup with a `?? value` fallback,
 * fails silently by printing the new enum member raw, and the surface that
 * looks most correct (it rendered something!) is the one nobody notices is
 * wrong.
 *
 * ── What is deliberately NOT here ────────────────────────────────────────────
 *
 * No sentence here diagnoses anything. A first failed stage is where the chain
 * stopped, and a failure category is the bucket a run is grouped under; neither
 * is a claim about WHY it stopped, and phrasing that suggests otherwise is how
 * an operator ends up "fixing" the wrong system.
 */

import {
  FAILURE_CATEGORIES,
  STAGE_STATES,
  USER_VALUE_STAGES,
  type FailureCategory,
  type StageState,
  type UserValueStage,
} from "./chain.js";
import { STAGE_REASONS, type StageReason } from "./stage-derivation.js";
import {
  EVAL_VERDICT_DECISION_REASONS,
  type EvalVerdictDecisionReason,
} from "./verdict-policy.js";

/**
 * The six chain stages, in words.
 *
 * `userValue` is the one that matters: it is the stage a reader is most likely
 * to see (it is last, so it is where a mechanically-perfect run still fails)
 * and it is the one whose wire spelling reads worst.
 */
export const USER_VALUE_STAGE_LABELS = Object.freeze({
  connection: "Connection",
  discovery: "Discovery",
  selection: "Selection",
  call: "Tool call",
  response: "Response",
  userValue: "User value",
} satisfies Record<UserValueStage, string>);

/**
 * What a stage did.
 *
 * The three non-verdicts stay three different sentences, exactly as
 * `STAGE_STATES` insists: "we did not check", "it does not apply" and "it never
 * ran" are different facts, and one shared word for them is how "we never
 * checked" gets read as "it passed".
 */
export const STAGE_STATE_LABELS = Object.freeze({
  passed: "passed",
  failed: "failed",
  notReached: "never ran (an earlier stage failed)",
  notMeasured: "not measured",
  notApplicable: "not applicable to this case",
} satisfies Record<StageState, string>);

/** The coarse bucket a non-passing run is grouped under. */
export const FAILURE_CATEGORY_LABELS = Object.freeze({
  setup: "setup",
  metadata: "tool metadata",
  selection: "tool selection",
  arguments: "call arguments",
  serverData: "server data",
  userValue: "user value",
  evaluator: "evaluator",
} satisfies Record<FailureCategory, string>);

/**
 * Why a stage landed where it did.
 *
 * Written as fragments that complete "…because <reason>", so a renderer can
 * splice one into a line without a per-reason special case.
 */
export const STAGE_REASON_LABELS = Object.freeze({
  noSpanChannel: "this run captures no evidence channel for that stage",
  noEvidenceCaptured: "nothing eligible for that stage was captured",
  matchVerdictUnavailable:
    "extra tool calls were captured but the run did not report whether its match options tolerate them",
  traceAbsent: "the iteration recorded no trace",
  executorEmitsNoSpans: "the executor emitted no spans",
  blockedByPolicy: "a policy blocked the run before it could be measured",
  evaluatorError:
    "the evaluator itself failed, so the run says nothing about the server",
  providerError:
    "the model provider failed the call, so the run never reached the server",
  setupAborted: "the environment was never prepared, so the test never began",
  connectFailed:
    "the configured server was reached and initialize failed there",
  toolsListFailed: "initialize succeeded and listing tools failed",
  egressUnverified:
    "the connection failed with no evidence that our own network egress works",
  lifecycleStopped: "the run was stopped mid-flight",
  notAuthored: "the case asserts nothing this stage could decide",
  earlierStageFailed: "an earlier stage failed",
  missingToolCall: "an expected tool call was never made",
  unexpectedToolCall: "a tool call was made that the case did not expect",
  argumentMismatch: "the call arguments did not match what the case expects",
  toolError: "the server reported a tool error",
  protocolError: "the call never produced a result",
  renderFailed: "the widget did not render",
  predicateFailed: "a check on the result did not hold",
  observed: "the evidence was inspected and the stage held",
  impliedByLaterEvidence: "a later stage's success implies it",
  // "LLM judge", not "judge". These five are the only reasons in the
  // vocabulary decided by a model rather than by a deterministic rule, and a
  // reader who cannot tell the two apart cannot weigh the row: an assertion
  // that failed and an advisory verdict that came in low are different kinds
  // of claim. The provenance belongs in the label because these strings are
  // the ONE place all four renderers read from.
  judgeObserved: "the LLM judge scored at or above the threshold",
  judgePartial:
    "the LLM judge scored inside the partial band — above the floor, below the threshold",
  judgeFailed: "the LLM judge scored below the partial floor",
  judgePending: "an LLM judge verdict is owed and has not arrived",
  judgeNotRequested: "no LLM judge verdict was ever owed",
} satisfies Record<StageReason, string>);

/**
 * Why a v2 run's verdict is what it is.
 *
 * These are the audit trail an `inconclusive` run is explained by, and they are
 * the single most useful thing to put in front of someone staring at a run that
 * neither passed nor failed. Phrased as statements of what was measured, never
 * as blame.
 */
export const EVAL_VERDICT_DECISION_REASON_LABELS = Object.freeze({
  configuredTrialsNotAttempted:
    "some configured trial never ran, so the run does not cover what it was asked to",
  noGradeableTrials: "nothing in the run produced a gradeable verdict",
  eligibleTrialsBelowMinimum:
    "fewer gradeable trials than the suite's validity floor requires",
  completionRateBelowMinimum:
    "too few attempted trials completed to meet the suite's completion floor",
  completionRateNotMeasured:
    "nothing was attempted, so the completion floor cannot be satisfied",
  evaluatorErrorRateAboveMaximum:
    "the evaluator failed too often for this run to describe the server",
  evaluatorErrorRateNotMeasured:
    "nothing was attempted, so the evaluator-error ceiling cannot be satisfied",
  caseHasNoEligibleTrials: "a case graded nothing at all",
  casePassRateMetThreshold: "the case met its pass threshold",
  casePassRateBelowThreshold: "a case did not meet its pass threshold",
  allMeasuredCasesMetThreshold: "every measured case met its threshold",
} satisfies Record<EvalVerdictDecisionReason, string>);

/**
 * The operator action for one failure category.
 *
 * Relocated here from `src/eval-decision-summary.ts`, which still re-exports it
 * under its published name. One action per category, and the category is the
 * only input: an action keyed on anything finer would be a diagnosis, and this
 * contract does not diagnose.
 */
export const NEXT_ACTION_BY_FAILURE_CATEGORY = Object.freeze({
  setup: "check the server connection and environment configuration",
  metadata: "review the tool metadata and descriptions in the server catalog",
  selection: "review tool selection and the tool catalog",
  arguments: "review the authored arguments against the tool input schema",
  serverData: "inspect the tool response returned by the server",
  userValue: "review whether the response answered the user's goal",
  evaluator: "check the evaluator configuration; the case was not graded",
} satisfies Record<FailureCategory, string>);

/**
 * The action when no failure category was established.
 *
 * Deliberately says to go and look rather than naming a system: with no
 * category there is no evidence about which one is involved, and a confident
 * suggestion here would be invention.
 */
export const DECISION_SUMMARY_FALLBACK_NEXT_ACTION =
  "inspect the case trace; no failure category was recorded";

/**
 * The action when the recorded verdict and the measured chain DISAGREE.
 *
 * A narrower, and therefore more useful, statement than the fallback above:
 * the chain validated, every applicable stage came back ok, and the verdict
 * still says failed. "No failure category was recorded" is true of that run
 * but describes it as an absence of information, when in fact two things we
 * hold are in conflict — which is a different thing to go and look at.
 *
 * Named as a disagreement and nothing more. The chain cannot see WHY from
 * here, and a guess at the cause dressed as a finding is exactly what this
 * whole vocabulary exists to prevent.
 */
export const DECISION_SUMMARY_VERDICT_CHAIN_DISAGREEMENT_NEXT_ACTION =
  "the recorded verdict disagrees with the measured chain; inspect the case trace";

/**
 * The same disagreement on a run whose chain predates analyzer 7.
 *
 * What the version proves is NARROW, and the first draft of this line over-read
 * it. A pre-7 analyzer could not report an errored tool call on a case that
 * authored no tool expectation — but that is a statement about what the
 * analyzer was ABLE to see, never evidence that such a call occurred. Naming
 * the tool error as the cause would have sent a reader after a specific
 * finding on every legacy row, whatever actually went wrong.
 *
 * So this says only what the row itself establishes: the chain was derived by
 * an analyzer that measures strictly less than the current one, and
 * re-deriving may therefore attribute what this one could not. That makes
 * "re-run" a real instruction without attaching a cause to it.
 */
export const DECISION_SUMMARY_STALE_ANALYZER_DISAGREEMENT_NEXT_ACTION =
  "the recorded verdict disagrees with the measured chain; this run's chain was derived by an older analyzer that measures less than the current one — re-run the case before investigating further";

/** Every vocabulary this module renders, for tests that assert totality. */
export const DECISION_LABEL_VOCABULARIES = Object.freeze({
  stages: USER_VALUE_STAGES,
  stageStates: STAGE_STATES,
  failureCategories: FAILURE_CATEGORIES,
  stageReasons: STAGE_REASONS,
  verdictDecisionReasons: EVAL_VERDICT_DECISION_REASONS,
});
