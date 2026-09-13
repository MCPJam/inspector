/**
 * Which stage of the user-value chain each evaluator measures.
 *
 * The chain already answers "where did this run stop being good?" per
 * iteration. What no surface could answer until now is the same question about
 * the SETTINGS: given a suite's configuration, which stages does it actually
 * measure, and which does it leave unchecked? A settings page that groups its
 * evaluators by stage needs exactly this map, and deriving it in the client
 * would put a second, quietly diverging copy of the analyzer's routing next to
 * the real one.
 *
 * So it is EXPORTED FROM THE CONTRACT, and the analyzer's own selection routing
 * is derived from it rather than restated. The two cannot disagree, because
 * there is only one of them.
 *
 * A NOTE ON WHAT THIS IS NOT. It describes where an evaluator's evidence is
 * FILED, not where the underlying failure happened. `noToolErrors` files at
 * `response` because that is what analyzer 11 does with it, and the honest
 * reading of any entry here is "this is where the analyzer puts it" rather than
 * "this is what went wrong". The candidates for a future move are named at the
 * table, so that a future analyzer bump is a deliberate, versioned change and
 * not a bug fix someone applies to this file in isolation.
 *
 * ── Why the seed is NOT in this file ─────────────────────────────────────────
 *
 * `RECOMMENDED_DEFAULT_PREDICATES` stays declared in `grader-stage.ts`, and
 * `./index.ts` re-exports it as `RECOMMENDED_DEFAULT_ASSERTIONS`; this module
 * neither owns nor re-exports it. The backend pins that list
 * through a whole-file `capture` in `convex/lib/mirrors.json` — a regex over the
 * three `{ type, role, severity }` triples, matched against THIS repository's
 * `grader-stage.ts`. A capture that matches nothing hashes to a stable empty
 * string, so moving the literal would not fail the pin: it would make the pin
 * pass forever, from the moment it stopped watching anything.
 *
 * The stage tables move. The seed does not.
 */

import type { UserValueStage } from "./chain.js";
import { predicateUnion } from "../predicates/types.js";

/**
 * Every assertion kind the authoring schema admits, derived from the schema
 * itself.
 *
 * Derived rather than listed, because a hand-written list is a list that
 * silently misses the next assertion someone adds — and an assertion absent
 * from this map is an evaluator a settings page cannot place, which renders as
 * a stage that looks unmeasured when it is not.
 *
 * Reads `.options` from the underlying discriminated union, not from
 * `predicateSchema` — that wrapper is a refinement (`severity` requires
 * `role: "advisory"`) and has no `.options`.
 */
export const ASSERTION_KINDS = predicateUnion.options.map(
  (option: { shape: { type: { value: string } } }) => option.shape.type.value
) as readonly AssertionKind[];

export type AssertionKind =
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
export const ASSERTION_STAGE: Record<AssertionKind, UserValueStage> = {
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
export const EVALUATOR_STAGE = {
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
export const EVALUATOR_PRESENTATION_GROUP: Partial<
  Record<AssertionKind, "budget">
> = {
  tokenBudgetUnder: "budget",
  turnCountUnder: "budget",
};

/** True when this assertion kind's evidence is filed at `selection`. */
export function isSelectionStageAssertionKind(
  kind: string | undefined
): boolean {
  return (
    kind !== undefined &&
    kind in ASSERTION_STAGE &&
    ASSERTION_STAGE[kind as AssertionKind] === "selection"
  );
}
