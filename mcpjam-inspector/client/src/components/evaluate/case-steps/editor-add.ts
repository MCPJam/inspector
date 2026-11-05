/**
 * What "Add assertion" and "Add actions or assertions" write.
 *
 * An assertion that can grade one step goes into `steps` right after the
 * block it was added from, so it grades that step. One that only makes sense
 * over the whole run goes to the case's own after-run list.
 */

import { isTurnScopablePredicateKind } from "@mcpjam/sdk/predicates";
import {
  insertStepAfter,
  newStepId,
  type AssertStep,
  type TestStep,
} from "@/shared/steps";
import { blankPredicate } from "@/shared/predicate-kinds";
import type { CasePredicates } from "@/shared/eval-matching";
import {
  blankStepOfKind,
  defaultWidgetAssertion,
} from "@/components/evals/step-fields";
import type { EvalAddChoice } from "@/components/evals/eval-add-catalog";

export type AddResult =
  | { kind: "steps"; steps: TestStep[]; addedId: string }
  | { kind: "predicates"; predicates: CasePredicates }
  | { kind: "outcome" }
  | { kind: "none" };

/**
 * The id the new step goes after: the block's last assertion, or the action
 * itself when it has none, so additions keep the order they were made in.
 */
export function blockEndId(steps: TestStep[], actionId: string): string {
  const start = steps.findIndex((step) => step.id === actionId);
  if (start < 0) return actionId;
  let end = start;
  while (steps[end + 1]?.kind === "assert") end += 1;
  return steps[end]!.id;
}

export function applyAddChoice(input: {
  choice: EvalAddChoice;
  steps: TestStep[];
  predicates: CasePredicates | undefined;
  /** The action the button sits under; null for the after-run list. */
  actionId: string | null;
  suiteServers: string[];
}): AddResult {
  const { choice, steps, predicates, actionId } = input;
  const appendWholeRun = (
    predicate: ReturnType<typeof blankPredicate>,
  ): AddResult => ({
    kind: "predicates",
    predicates: {
      mode: predicates?.mode ?? "extend",
      list: [...(predicates?.list ?? []), predicate],
    },
  });
  switch (choice.kind) {
    case "outcome":
      return { kind: "outcome" };
    case "route-check":
      return { kind: "none" };
    case "check":
      if (
        actionId === null ||
        !isTurnScopablePredicateKind(choice.predicateKind)
      )
        return appendWholeRun(blankPredicate(choice.predicateKind));
      return insertAssertion(
        steps,
        actionId,
        blankPredicate(choice.predicateKind),
      );
    case "widget-check":
      if (actionId === null) return { kind: "none" };
      return insertAssertion(
        steps,
        actionId,
        defaultWidgetAssertion(choice.widgetKind, ""),
      );
    case "step": {
      const step = blankStepOfKind(choice.stepKind, input.suiteServers);
      const after =
        actionId === null
          ? (steps.at(-1)?.id ?? null)
          : blockEndId(steps, actionId);
      return {
        kind: "steps",
        steps: insertStepAfter(steps, after, step),
        addedId: step.id,
      };
    }
  }
}

function insertAssertion(
  steps: TestStep[],
  actionId: string,
  assertion: AssertStep["assertion"],
): AddResult {
  const step: AssertStep = {
    id: newStepId("assert"),
    kind: "assert",
    assertion,
  };
  return {
    kind: "steps",
    steps: insertStepAfter(steps, blockEndId(steps, actionId), step),
    addedId: step.id,
  };
}
