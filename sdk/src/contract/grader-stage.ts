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
import { predicateSchema } from "../predicates/types.js";

/**
 * Every predicate kind the authoring schema admits, derived from the schema
 * itself.
 *
 * Derived rather than listed, because a hand-written list is a list that
 * silently misses the next predicate someone adds — and a predicate absent
 * from this map is a grader a settings page cannot place, which renders as a
 * stage that looks unmeasured when it is not.
 */
export const PREDICATE_KINDS = predicateSchema.options.map(
  (option: { shape: { type: { value: string } } }) => option.shape.type.value
) as readonly PredicateKind[];

export type PredicateKind =
  (typeof predicateSchema)["options"][number]["shape"]["type"]["value"];

/**
 * Where each predicate kind's evidence is filed.
 *
 * `toolCalledWith` maps to `selection` and is the one entry that is not a
 * predicate row at runtime: `stepsToPromptTurns` promotes it into
 * `expectedToolCalls`, where the selection MATCHER grades it. It belongs in
 * this map anyway, because an author who wrote it is measuring selection and a
 * settings page must say so — but nothing should read this entry as licence to
 * re-read its raw predicate row, which would let a point-in-time residual
 * contradict the adjudicated matcher verdict.
 *
 * FUTURE ANALYZER-BUMP CANDIDATES, named so nobody "fixes" them here alone:
 * `noToolErrors` is arguably `call` or `response` evidence, and the three
 * `widget*` kinds are arguably `response`. Moving any of them changes where
 * historical failures are attributed, so each is a `STAGE_ANALYZER_VERSION`
 * bump with a re-derivation, not an edit to this table.
 */
export const PREDICATE_STAGE: Record<PredicateKind, UserValueStage> = {
  // ── Selection: which tool the model chose ───────────────────────────────
  toolCalledWith: "selection",
  toolCalledAtLeastOnce: "selection",
  toolNeverCalled: "selection",
  firstToolWas: "selection",
  // ── User value: did the person get what they asked for ──────────────────
  responseContains: "userValue",
  responseMatches: "userValue",
  finalAssistantMessageNonEmpty: "userValue",
  noToolErrors: "userValue",
  tokenBudgetUnder: "userValue",
  turnCountUnder: "userValue",
  widgetRendered: "userValue",
  widgetRenderLatencyUnder: "userValue",
  widgetNoConsoleErrors: "userValue",
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
