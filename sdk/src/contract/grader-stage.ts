/**
 * Which stage of the user-value chain each grader measures.
 *
 * The chain already answers "where did this run stop being good?" per trial.
 * What no surface could answer until now is the same question about the
 * SETTINGS: given a suite's configuration, which stages does it actually
 * measure, and which does it leave unchecked? A settings page that groups its
 * graders by stage needs exactly this map, and deriving it in the client would
 * put a second, quietly diverging copy of the analyzer's routing next to the
 * real one.
 *
 * So it is EXPORTED FROM THE CONTRACT, and the analyzer's own selection
 * routing is derived from it rather than restated. The two cannot disagree,
 * because there is only one of them.
 *
 * A NOTE ON WHAT THIS IS NOT. It describes where a grader's evidence is FILED,
 * not where the underlying failure happened. `noToolErrors` routes to
 * `userValue` because that is what analyzer v8 does with it today, and the
 * honest reading of that is "this stage has not been split out yet" rather
 * than "a tool error is a user-value failure". Those candidates are named
 * below so that a future analyzer bump is a deliberate, versioned change and
 * not a bug fix someone applies to this file in isolation.
 */

import type { UserValueStage } from "./chain.js";
import { predicateUnion } from "../predicates/types.js";

/**
 * Every predicate kind the authoring schema admits, derived from the schema
 * itself.
 *
 * Derived rather than listed, because a hand-written list is a list that
 * silently misses the next predicate someone adds — and a predicate absent
 * from this map is a grader a settings page cannot place, which renders as a
 * stage that looks unmeasured when it is not.
 *
 * Reads `.options` from the underlying discriminated union, not from
 * `predicateSchema` — that wrapper is a refinement (`severity` requires
 * `role: "advisory"`) and has no `.options`.
 */
export const PREDICATE_KINDS = predicateUnion.options.map(
  (option: { shape: { type: { value: string } } }) => option.shape.type.value
) as readonly PredicateKind[];

export type PredicateKind =
  (typeof predicateUnion)["options"][number]["shape"]["type"]["value"];

/**
 * Where each predicate kind's evidence is filed.
 *
 * `toolCalledWith` maps to `selection`. A **gating** `toolCalledWith` is
 * promoted into `expectedToolCalls` (`stepsToPromptTurns` / corpus
 * materialization), where the selection MATCHER grades it. An **advisory**
 * `toolCalledWith` stays a predicate row — promoting it would mint a matcher
 * expectation that can fail the trial, which Warn/Report must never do. It
 * belongs in this map anyway, because an author who wrote it is measuring
 * selection and a settings page must say so — but nothing should read this
 * entry as licence to re-read a gating residual, which would let a
 * point-in-time row contradict the adjudicated matcher verdict.
 *
 * FUTURE ANALYZER-BUMP CANDIDATES, named so nobody "fixes" them here alone:
 * the three `widget*` kinds are arguably `response`. Moving any of them
 * changes where historical failures are attributed, so each is a
 * `STAGE_ANALYZER_VERSION` bump with a re-derivation, not an edit to this
 * table. (`noToolErrors` was one of these; analyzer 11 moved it.)
 */
export const PREDICATE_STAGE: Record<PredicateKind, UserValueStage> = {
  // ── Selection: which tool the model chose ───────────────────────────────
  toolCalledWith: "selection",
  toolCalledAtLeastOnce: "selection",
  toolNeverCalled: "selection",
  // Which tools were allowed to be called is a SELECTION claim, same as the
  // forbidden-tool check it generalizes.
  onlyToolsCalled: "selection",
  firstToolWas: "selection",
  // ── Selection: which tools the run reached ──────────────────────────────
  //
  // Count and route kinds file HERE, not at `call`: they are about which tools
  // were reached and in what order, which is the selection question. `call` is
  // about whether the call that was made was usable.
  toolCallCountUnder: "selection",
  toolCalledBefore: "selection",
  noDeprecatedToolCalled: "selection",
  noDestructiveToolCalled: "selection",
  // ── Tool call: was the call itself well formed ──────────────────────────
  argumentsMatchToolSchema: "call",
  noRepeatedIdenticalCall: "call",
  // ── Response: what the server answered with ─────────────────────────────
  //
  // `noToolErrors` MOVED HERE in analyzer 11, from `userValue` where it had
  // been filed since v8. The docblock above named it as a bump candidate for
  // exactly this reason: a tool error is the server's answer, not a statement
  // about whether the person got what they asked for. Until the bump it
  // failed BOTH stages on the same evidence — the analyzer already failed
  // `response` on an observed tool error while the predicate row failed
  // `userValue` — so one defect was counted twice and `firstFailedStage`
  // depended on which the reader looked at first.
  noToolErrors: "response",
  toolLatencyUnder: "response",
  toolResultContains: "response",
  toolResultMatchesSchema: "response",
  toolResultSizeUnder: "response",
  toolErrorNamesInput: "response",
  fullPageHasContinuation: "response",
  // ── User value: did the person get what they asked for ──────────────────
  responseContains: "userValue",
  responseMatches: "userValue",
  finalAssistantMessageNonEmpty: "userValue",
  tokenBudgetUnder: "userValue",
  turnCountUnder: "userValue",
  widgetRendered: "userValue",
  widgetRenderLatencyUnder: "userValue",
  widgetNoConsoleErrors: "userValue",
  // An answer that ends by asking the user something is a statement about
  // what the person walked away with, so it files here — as an OBSERVATION,
  // which is a policy fact (`OBSERVATION_PREDICATE_KINDS`) rather than a
  // routing one. Advisory rows never decide a stage, so this entry places the
  // grader on the settings page and nothing more.
  noEndingQuestion: "userValue",
};

/**
 * Where each non-predicate grader's evidence is filed.
 *
 * Two entries, and both are projections rather than authored predicates: the
 * tool-call matcher, and the hosted goal-completion judge.
 */
export const GRADER_STAGE = {
  "toolCalls:match": "selection",
  "judge:goalCompletion": "userValue",
  /**
   * Presentation routing only. Groundedness has no score definition until
   * R2-P2b and cannot author a second chain.
   */
  "judge:groundedness": "userValue",
} as const satisfies Record<string, UserValueStage>;

/**
 * Graders a settings page groups together for PRESENTATION, against the stage
 * they are actually filed under.
 *
 * Budgets are the case: a token ceiling and a turn ceiling both file at
 * `userValue`, but reading them beside "did the answer contain the right
 * thing" makes neither legible. Grouping them is a rendering decision and
 * carries no analytical weight — nothing derives a verdict from this.
 */
export const GRADER_PRESENTATION_GROUP: Partial<
  Record<PredicateKind, "budget">
> = {
  tokenBudgetUnder: "budget",
  turnCountUnder: "budget",
};

/**
 * The checks a NEW suite starts with when its creator says nothing about
 * checks at all.
 *
 * HAND-MIRRORED from `mcpjam-backend/convex/lib/predicates.ts`
 * (`RECOMMENDED_DEFAULT_PREDICATES`), which is where the seed is APPLIED. This
 * copy exists so the scorer library can mark these kinds "Recommended", and so
 * the acceptance-corpus test can prove — on this side, where the evaluator
 * lives — that nothing enters the set above the corpus bar.
 *
 * NOTHING HERE GATES. The predicate gate is independent of a case's
 * `failOnToolError`, so a seeded gating `noToolErrors` would flip a case that
 * sets it false, hits an error, recovers and passes today. Warn preserves
 * effective case policy: the row is visible, the verdict is untouched.
 *
 * `noDeprecatedToolCalled` is an observation and is here on EVIDENCE: it is the
 * one heuristic that clears the corpus bar (zero detector errors and zero
 * misleading firings). The other four observations do not, and a kind that
 * starts firing misleadingly on a newly added corpus item leaves this list.
 */
export const RECOMMENDED_DEFAULT_PREDICATES = [
  { type: "noToolErrors", role: "advisory", severity: "warn" },
  { type: "argumentsMatchToolSchema", role: "advisory", severity: "warn" },
  { type: "noDeprecatedToolCalled", role: "advisory", severity: "warn" },
] as const satisfies ReadonlyArray<{
  type: PredicateKind;
  role: "advisory";
  severity: "warn";
}>;

/** True when a new suite starts with this kind. Drives the "Recommended" chip. */
export function isRecommendedDefaultPredicateKind(kind: string): boolean {
  return RECOMMENDED_DEFAULT_PREDICATES.some(
    (predicate) => predicate.type === kind
  );
}

/** True when this predicate kind's evidence is filed at `selection`. */
export function isSelectionStagePredicateKind(
  kind: string | undefined
): boolean {
  return (
    kind !== undefined &&
    kind in PREDICATE_STAGE &&
    PREDICATE_STAGE[kind as PredicateKind] === "selection"
  );
}
