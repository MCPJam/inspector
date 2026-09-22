/**
 * Pure projections behind the spine.
 *
 * The spine renders one list: numbered actions with their checks nested
 * underneath, then an "After the run" block. Everything here answers a
 * question about that list without touching React — which rows go after the
 * run, which status a row wears, what deleting an action would do to the
 * checks under it, and whether the case is still quiet enough to show the
 * two-question first-run form instead.
 */

import type { EvalStepStatus } from "@/shared/eval-stream-events";
import {
  actionRows,
  isAssertStep,
  stepTurnIndices,
  type TestStep,
} from "@/shared/steps";
import { removeStepById } from "../simple-case/simple-case-model";
import type { CasePredicates } from "@/shared/eval-matching";
import type {
  CaseScorecard,
  ScorecardRow,
} from "../case-scorecard/case-scorecard-model";
import type { ToolsChoice } from "../simple-case/simple-case-model";

/** A row of the "After the run" block: whole-run checks, in list order. */
export type AfterRunRow = ScorecardRow;

/**
 * Whole-run rows, in the order the author wrote them.
 *
 * `buildCaseScorecard` groups by chain stage, which is right for the suite's
 * settings table — it answers "what grades selection?". After the run the
 * question is different: these all run at the same moment, over the same
 * finished transcript, so a stage heading over a two-row list is chrome. They
 * come back flattened in list order (case rows by their index, then suite,
 * with a snapshot replacing both), which is the order the author sees on the
 * suite page and the order their indices already mean.
 *
 * The judge is NOT here. It renders last, from `card.judge`, because it is a
 * block with its own goal field rather than a row.
 */
export function afterTheRunRows(card: CaseScorecard): AfterRunRow[] {
  const rows = card.groups.flatMap((group) => group.rows);
  const byProvenance = (want: ScorecardRow["provenance"]) =>
    rows
      .filter((row) => row.provenance === want)
      .sort((a, b) => (a.predicateIndex ?? 0) - (b.predicateIndex ?? 0));
  return [
    ...byProvenance("case"),
    ...byProvenance("suite"),
    ...byProvenance("snapshot"),
  ];
}

/**
 * The status a spine row wears, and whether it came from this exact step.
 *
 * Precedence is the Steps pane's, deliberately: a per-step verdict wins, and a
 * turn-derived one only fills in when there is none. The `assert` carve-out is
 * the important half — a turn's verdict says the TURN passed, and painting
 * that on a check would claim the check itself was measured when it may not
 * have run at all. `running` is exempt because a spinner on a pending check is
 * about the turn being in flight, which is true of the check too.
 */
export function spineStatus(input: {
  stepId: string;
  kind: TestStep["kind"];
  turnIndex: number;
  byId?: Map<string, EvalStepStatus>;
  byTurn?: Map<number, EvalStepStatus>;
}): { status: EvalStepStatus | undefined; perStep: boolean } {
  const own = input.byId?.get(input.stepId);
  if (own) return { status: own, perStep: true };
  const turn = input.byTurn?.get(input.turnIndex);
  if (!turn) return { status: undefined, perStep: false };
  if (input.kind === "assert" && turn !== "running") {
    return { status: undefined, perStep: false };
  }
  return { status: turn, perStep: false };
}

export type DeleteActionPlan = {
  /** Whether removing this action needs a confirmation first. */
  needsConfirm: boolean;
  /** The action the orphaned checks would re-parent to, if any. */
  reparentTo: { ordinal: number; stepId: string } | null;
  /** Checks nested under the action being removed. */
  movedChecks: number;
  /** Steps later in the same TURN that would fold into the previous turn. */
  movedFollowers: number;
  /** True when the orphans would end up before any action at all. */
  becomesLeading: boolean;
};

/**
 * What removing one action would actually do.
 *
 * Deleting a prompt does not delete the checks under it — `removeStepById`
 * takes one step, and the runner then folds every later assert into the
 * PREVIOUS turn (`stepTurnIndices`). So a check written to grade turn 2 starts
 * grading turn 1, silently. This computes the sentence that has to be said
 * before that happens, including the worst case: with no earlier action the
 * checks run before any prompt at all.
 */
export function deleteActionPlan(
  steps: TestStep[],
  actionId: string,
): DeleteActionPlan {
  const { actions } = actionRows(steps);
  const position = actions.findIndex((action) => action.step.id === actionId);
  const empty: DeleteActionPlan = {
    needsConfirm: false,
    reparentTo: null,
    movedChecks: 0,
    movedFollowers: 0,
    becomesLeading: false,
  };
  if (position === -1) return empty;
  const action = actions[position]!;
  const previous = actions[position - 1];
  const turns = stepTurnIndices(steps);
  const movedFollowers = steps.filter(
    (step, index) =>
      index > action.lastIndex &&
      turns[index] === action.turnIndex &&
      isAssertStep(step),
  ).length;
  const movedChecks = action.checks.length;
  if (movedChecks === 0 && movedFollowers === 0) return empty;
  return {
    needsConfirm: true,
    reparentTo: previous
      ? { ordinal: previous.ordinal, stepId: previous.step.id }
      : null,
    movedChecks,
    movedFollowers,
    becomesLeading: !previous,
  };
}

/** Remove an action and every check nested under it. */
export function removeActionWithChecks(
  steps: TestStep[],
  actionId: string,
): TestStep[] {
  const { actions } = actionRows(steps);
  const action = actions.find((a) => a.step.id === actionId);
  if (!action) return steps;
  const doomed = new Set([
    action.step.id,
    ...action.checks.map((c) => c.step.id),
  ]);
  return steps.filter((step) => !doomed.has(step.id));
}

/** Remove just the action; its checks re-parent to the action before it. */
export const removeActionOnly = removeStepById;

/**
 * Move one action, with its checks, past the adjacent action.
 *
 * The Steps pane swaps two STEPS, which on a spine would tear a check away
 * from the action it grades. Blocks move whole. Leading checks never move —
 * they belong to no action, and carrying them along would change which turn
 * they run in.
 */
export function moveActionBlock(
  steps: TestStep[],
  actionId: string,
  dir: -1 | 1,
): TestStep[] {
  const { leading, actions } = actionRows(steps);
  const position = actions.findIndex((action) => action.step.id === actionId);
  if (position === -1) return steps;
  const target = position + dir;
  if (target < 0 || target >= actions.length) return steps;
  const blocks = actions.map((action) => [
    action.step,
    ...action.checks.map((child) => child.step),
  ]);
  const moved = blocks[position]!;
  blocks[position] = blocks[target]!;
  blocks[target] = moved;
  return [...leading.map((child) => child.step), ...blocks.flat()];
}

/**
 * Whether the case is still just a prompt — the shape the first-run form
 * covers.
 *
 * "Quiet" is the state where the only honest questions are what to ask and
 * what a good answer accomplishes. The moment the case carries a check, a
 * route, a click or a second action, the author has said something the two
 * fields cannot show, and hiding it would be worse than the spine's chrome.
 *
 * A `noTool` choice counts as answered even though it adds no step: it is the
 * negative case's whole assertion.
 */
export function isQuietCase(input: {
  steps: TestStep[];
  predicates?: CasePredicates;
  toolsChoice?: ToolsChoice;
}): boolean {
  if (input.toolsChoice === "noTool") return false;
  const { leading, actions } = actionRows(input.steps);
  if (leading.length > 0) return false;
  // An empty draft is the quietest case there is — a brand-new case has no
  // steps until the first keystroke, and that is exactly where the two
  // questions belong.
  if (actions.length > 1) return false;
  const only = actions[0];
  if (only) {
    if (only.step.kind !== "prompt") return false;
    if (only.checks.length > 0) return false;
  }
  const envelope = input.predicates;
  if (envelope && envelope.mode !== "inherit" && envelope.list.length > 0) {
    return false;
  }
  return true;
}
