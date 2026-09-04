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
import type { EvalStageCoverageDetail } from "./stage-analytics.js";
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
 * The question each stage answers, for a reader who is looking at one.
 *
 * Prose taken from the NORMATIVE stage descriptions in `chain.ts` — the array
 * whose order is load-bearing — and turned into the question a reader is
 * actually asking when they click a stage. Written as questions rather than
 * as nouns because a stage card answers something: "Discovery" is a label, and
 * "Did the client receive usable primitives and metadata?" is what the reader
 * came to find out.
 *
 * None of these diagnoses. Each asks about the chain link and stops there;
 * "why did it fail" is not a question this vocabulary can answer, and phrasing
 * one here would put an invented cause in front of every failing stage.
 */
export const USER_VALUE_STAGE_QUESTIONS = Object.freeze({
  connection: "Could the client reach the server and initialize a session?",
  discovery: "Did the client receive usable primitives and metadata?",
  selection: "Did the model choose the right tool for the request?",
  call: "Was the call made with usable arguments?",
  response: "Did the server return data the model could use?",
  userValue: "Was the user's actual request satisfied?",
} satisfies Record<UserValueStage, string>);

/**
 * What GOOD looks like at each stage, in the past tense.
 *
 * The outcome-oriented companion to {@link USER_VALUE_STAGE_QUESTIONS}: the
 * same six links, said as the thing that happened when the link held. A row of
 * stage chips reading "Session connected → Tools and resources discovered →
 * Right tool selected" tells the delivery story; a row reading
 * "passed → passed → passed"
 * tells the reader only that six checks ran.
 *
 * ONLY for a stage measured as passed. These are claims about the chain
 * holding, so putting one on an unmeasured stage would state as observed
 * exactly the thing nobody observed — which is what the five-state vocabulary
 * in `STAGE_STATES` exists to make impossible.
 */
export const USER_VALUE_STAGE_OUTCOMES = Object.freeze({
  connection: "Session connected",
  // "and resources", because the stage is not tools-only: `chain.ts` defines
  // discovery as "its tools/resources were listed and readable", and the
  // question map asks about "usable primitives and metadata". A resource-only
  // server that discovered fine would have been told its tools were found.
  discovery: "Tools and resources discovered",
  selection: "Right tool selected",
  call: "Valid call made",
  response: "Usable response returned",
  userValue: "Request satisfied",
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
  // Scoped to THIS STAGE, not to the run. `providerError` is applied per row,
  // and a multi-turn iteration whose provider died at turn 4 keeps its earlier
  // measured rows — so a run-level "never reached the server" would sit
  // directly beside a `call: passed` that disproves it, and send a reader
  // after the wrong timeline.
  providerError:
    "the model provider failed the call, so this stage was never measured",
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
  // "AT or above the floor": the band is `>= partialFloor` and `< threshold`
  // (`stage-derivation.ts`), so a score exactly ON the floor is partial. These
  // strings are the one place every renderer reads from, and "above the floor"
  // described the boundary score as outside a band it is inside.
  judgePartial:
    "the LLM judge scored inside the partial band — at or above the floor, below the threshold",
  judgeFailed: "the LLM judge scored below the partial floor",
  judgePending: "an LLM judge verdict is owed and has not arrived",
  judgeNotRequested: "no LLM judge verdict was ever owed",
} satisfies Record<StageReason, string>);

/**
 * The ONE thing a reader is supposed to do next, per stage reason.
 *
 * {@link NEXT_ACTION_BY_FAILURE_CATEGORY} below stays, and stays the fallback:
 * it answers at the coarse bucket, seven categories with one action each, and
 * a category can only ever name a system to go and look at. A stage reason is
 * the finest thing the contract records about where the chain stopped, so a
 * remedy keyed on it can name the actual assertion, schema or recipe field to
 * open — which is a narrower promise than the category map makes, and the only
 * reason to keep a second map at all.
 *
 * ── Why this one is `Partial` ────────────────────────────────────────────────
 *
 * Every other map here is total over its vocabulary on purpose. This one is
 * not, and the gap is the content. A reason that says nothing about the server
 * — MCPJam's own provider failure, an unverified egress, a stage that simply
 * was not measured, an earlier stage having failed, and every passing reason —
 * has no remedy for the reader to act on, and inventing one would send them
 * after a system that is not involved. The omission is recorded rather than
 * implied: {@link STAGE_REASONS_WITHOUT_REMEDY} names exactly those, so a
 * missing key is a decision somebody made and not one somebody forgot.
 *
 * None of these sentences diagnoses. Each says what to go and change, and
 * where the honest answer is that either side could be the one that moved, it
 * says both and leaves the choice to the reader — who can see the diff, and
 * we cannot.
 */
export const STAGE_REASON_REMEDIES = Object.freeze({
  missingToolCall:
    "if this pull request intentionally renamed or removed the expected tool, update this case's expected tool call in MCPJam so the assertion matches the server; if the tool should still be chosen for this prompt, review its name and description in the tool catalog, then push again",
  unexpectedToolCall:
    "decide which side is right: if the extra call is correct behaviour, widen this case's expected tool calls or its match options in MCPJam; if it is not, review the names and descriptions that made the extra tool look applicable",
  argumentMismatch:
    "compare the recorded call against the tool's input schema: if this pull request changed the schema, update the case's expected arguments in MCPJam; otherwise review the parameter descriptions that led the model to fill them this way",
  toolError:
    "read the error the server returned on the tool result: fix the handler if the arguments were valid, or tighten the input schema so the model cannot send what the handler rejects",
  protocolError:
    "the call failed instead of returning a result: read the recorded failure for that call, and its error code where one was captured, to tell a rejection by the server from a connection that broke between the two sides",
  renderFailed:
    "read the recorded render status: it names the step that failed — for example no UI resource on the tool result, a widget that never mounted, or a bridge handshake that never completed",
  predicateFailed:
    "read the recorded reasons: either this pull request changed the response, or the case asserts something the server no longer promises",
  connectFailed:
    "the server was reached and initialize failed there: check the start command in the run recipe and the port the recipe declares",
  toolsListFailed:
    "initialize succeeded and listing tools failed: check the server's tools/list handler",
  setupAborted:
    "the environment was never prepared, so nothing here is a statement about the server: check the build and start steps in the run recipe",
  evaluatorError:
    "the evaluator itself failed, so this case says nothing about the server: check the suite's evaluator configuration",
  blockedByPolicy:
    "a policy stopped this run before it could be measured: check the suite's tool policy and the environment it runs against",
  lifecycleStopped:
    "the run was stopped mid-flight, so this case reached no verdict: re-run the check",
  notAuthored:
    "this case asserts nothing this stage could decide: add an assertion in MCPJam if this stage should be measured",
  judgeFailed:
    "read the judge's rationale on the run: either the response stopped satisfying the case's goal, or the goal needs rewording to match what the server now returns",
  judgePartial:
    "read the judge's rationale on the run: the response was close to the case's goal but under its threshold, so either the server's answer or the threshold needs to move",
} satisfies Partial<Record<StageReason, string>>);

/**
 * The reasons that deliberately carry no remedy.
 *
 * The complement of {@link STAGE_REASON_REMEDIES}, written down in the
 * contract instead of hand-listed inside a test, so the two can be asserted to
 * PARTITION `STAGE_REASONS` exactly: their union is the whole vocabulary and
 * their intersection is empty.
 *
 * That is the same forcing function the total maps above get from
 * `satisfies Record<Enum, string>`, kept for the one map that cannot be total.
 * Adding a reason to the contract breaks the partition until somebody decides
 * which side it belongs on — a next step for the reader, or an honest nothing
 * — rather than silently producing a failing case whose remedy line is blank
 * and whose absence nobody can see.
 */
export const STAGE_REASONS_WITHOUT_REMEDY = Object.freeze([
  "noSpanChannel",
  "noEvidenceCaptured",
  "matchVerdictUnavailable",
  "traceAbsent",
  "executorEmitsNoSpans",
  "providerError",
  "egressUnverified",
  "earlierStageFailed",
  "observed",
  "impliedByLaterEvidence",
  "judgeObserved",
  "judgePending",
  "judgeNotRequested",
] as const satisfies readonly StageReason[]);

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

/**
 * One key of the fine-grained exclusion detail.
 *
 * Derived from the schema's inferred type rather than hand-listed, so the map
 * below is total over what the CONTRACT declares. A hand list would let the
 * schema gain a fifteenth key while this file still compiled, printing the new
 * wire spelling raw at the one reader that renders it.
 */
export type EvalStageCoverageDetailKey = keyof EvalStageCoverageDetail;

/**
 * The FINE-GRAINED reason a trial was excluded from a run's analytics.
 *
 * The coarse six (`EvalStageExclusions`) answer "which denominator lost this
 * trial"; these fourteen answer "and what actually happened to it", which is
 * the difference between two operator actions. `chainUnverified` — a stored
 * derivation that did not validate — and `chainVersionAhead` — a producer
 * newer than this reader — both land in the coarse `integrity`/`version`
 * buckets, and a reader who cannot tell them apart cannot tell a bug from a
 * deploy window.
 *
 * Words, not the wire spelling, for the reason this whole module exists:
 * `measurementsVersionAhead` is correct on the wire and unreadable in a
 * disclosure line. The phrasing comes from the schema's own docblocks in
 * `stage-analytics.ts` and states what was observed without naming a culprit —
 * "produced by a newer analyzer than this reader knows" is a fact about the
 * two versions, not an accusation about either.
 */
export const EXCLUDED_TRIAL_DETAIL_LABELS = Object.freeze({
  // lifecycle — the trial never produced a comparable observation
  notTerminal: "still running, so nothing final to compare",
  skipped: "deliberately not run",
  cancelled: "cancelled before it finished",
  setupFailed: "its environment was never prepared, so the test never began",
  timedOut: "timed out",
  executionFailed: "failed to execute",
  evaluatorError:
    "the evaluator itself failed, so it says nothing about the server",
  // chain integrity — the derivation could not be believed
  chainMissing: "no stage chain was ever recorded",
  chainUnverified: "its stage chain did not validate",
  chainVersionAhead:
    "its stage chain was produced by a newer analyzer than this reader knows",
  // measurement integrity
  measurementsMissing: "no stage measurements were recorded",
  measurementsInvalid: "its stage measurements did not validate",
  measurementsVersionAhead:
    "its stage measurements were produced by a newer schema than this reader knows",
  // the two halves disagree about which analyzer produced them
  analyzerMismatch:
    "its chain and its measurements were produced by different analyzers",
} satisfies Record<EvalStageCoverageDetailKey, string>);

/**
 * The fine-grained exclusions, in words, omitting the ones that excluded
 * nothing.
 *
 * Same omit-zero convention the coarse `describeExclusions` follows on the
 * read side, and for the same contract reason: a class that excluded nothing
 * is OMITTED from the payload rather than written as `0`, so an absent key and
 * a `0` mean the same thing and neither is worth a line. Rendering "0 skipped"
 * would invite a reader to look for a skipped trial that does not exist.
 */
export function describeExcludedTrialDetail(
  detail: EvalStageCoverageDetail
): { key: EvalStageCoverageDetailKey; label: string; count: number }[] {
  const out: {
    key: EvalStageCoverageDetailKey;
    label: string;
    count: number;
  }[] = [];
  for (const key of Object.keys(
    EXCLUDED_TRIAL_DETAIL_LABELS
  ) as EvalStageCoverageDetailKey[]) {
    const count = detail[key];
    if (count !== undefined && count > 0) {
      out.push({ key, label: EXCLUDED_TRIAL_DETAIL_LABELS[key], count });
    }
  }
  return out;
}

/** Every vocabulary this module renders, for tests that assert totality. */
export const DECISION_LABEL_VOCABULARIES = Object.freeze({
  stages: USER_VALUE_STAGES,
  stageStates: STAGE_STATES,
  failureCategories: FAILURE_CATEGORIES,
  stageReasons: STAGE_REASONS,
  verdictDecisionReasons: EVAL_VERDICT_DECISION_REASONS,
  // NOT listed here: B7's `PREDICATE_STAGE`. This registry holds closed
  // member LISTS, and its consumer walks the OpenAPI spec asserting that any
  // enum overlapping one of them matches it exactly. `PREDICATE_STAGE` is a
  // map from predicate kind to stage, so it has no member list to guard —
  // and its VALUES are already `stages` above. Adding it would have meant
  // weakening that check to accommodate a shape it was never about. It is
  // exported from the contract index directly, which is how consumers reach
  // it.
  // NOT listed here: the fine-grained exclusion detail. Its vocabulary is a
  // zod object's SHAPE rather than a `const` array, so its totality test reads
  // `evalStageCoverageDetailSchema.shape` directly — a hand-copied list here
  // would be a second declaration of the same thing, and the one that goes
  // stale silently.
});
