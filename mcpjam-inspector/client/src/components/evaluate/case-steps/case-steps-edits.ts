/**
 * Pure edits the steps editor makes to a case. Every edit keeps storage as it
 * is today (E6): `steps` stays one flat list and an assert grades whatever
 * precedes it, so "add under step 2" is an insert at the end of step 2's block.
 */

import { isTurnScopablePredicateKind } from "@mcpjam/sdk/predicates";
import { blankPredicate } from "@/shared/predicate-kinds";
import type { CasePredicates, Predicate } from "@/shared/eval-matching";
import {
  insertStepAfter,
  newStepId,
  type AssertStep,
  type TestStep,
} from "@/shared/steps";
import type { EvalAddChoice } from "@/components/evals/eval-add-catalog";
import {
  blankStepOfKind,
  defaultWidgetAssertion,
} from "@/components/evals/step-fields";

/** What one Add choice changed, and which row should open expanded. */
export type CaseStepsAddResult = {
  steps: TestStep[];
  predicates: CasePredicates | undefined;
  /** `action:<id>`, `step:<id>` or `case:<index>`; `null` when nothing was added. */
  addedKey: string | null;
};

/**
 * Apply an Add choice made under one step (`anchorStepId`), or at the end of
 * the case (`null`, which appends after the last block).
 *
 * A check that cannot be scoped to one turn is graded over the finished run,
 * so it goes to the after-run assertions instead of under the step.
 */
export function applyAddChoice(input: {
  steps: TestStep[];
  predicates: CasePredicates | undefined;
  anchorStepId: string | null;
  choice: EvalAddChoice;
  suiteServers: string[];
}): CaseStepsAddResult {
  const { steps, predicates, choice } = input;
  const anchor = input.anchorStepId ?? steps.at(-1)?.id ?? null;
  const unchanged = { steps, predicates, addedKey: null };
  switch (choice.kind) {
    case "outcome":
    case "route-check":
      return unchanged;
    case "step": {
      const step = blankStepOfKind(choice.stepKind, input.suiteServers);
      return {
        steps: insertAt(steps, anchor, step),
        predicates,
        addedKey: `action:${step.id}`,
      };
    }
    case "check": {
      if (!isTurnScopablePredicateKind(choice.predicateKind)) {
        return addAfterRunAssertion(
          steps,
          predicates,
          blankPredicate(choice.predicateKind),
        );
      }
      return addAssertion(
        steps,
        predicates,
        anchor,
        blankPredicate(choice.predicateKind),
      );
    }
    case "widget-check":
      return addAssertion(
        steps,
        predicates,
        anchor,
        defaultWidgetAssertion(choice.widgetKind, ""),
      );
  }
}

/** Append one case-level assertion; `inherit` becomes `extend` so it runs. */
export function addAfterRunAssertion(
  steps: TestStep[],
  predicates: CasePredicates | undefined,
  predicate: Predicate,
): CaseStepsAddResult {
  const list = predicates?.mode === "inherit" ? [] : (predicates?.list ?? []);
  const mode = predicates?.mode === "replace" ? "replace" : "extend";
  return {
    steps,
    predicates: { ...predicates, mode, list: [...list, predicate] },
    addedKey: `case:${list.length}`,
  };
}

/** Replace or remove one case-level assertion by its index. */
export function editAfterRunAssertion(
  predicates: CasePredicates | undefined,
  index: number,
  next: Predicate | null,
): CasePredicates | undefined {
  if (!predicates) return predicates;
  const list = predicates.list.flatMap((item, at) =>
    at !== index ? [item] : next ? [next] : [],
  );
  return { ...predicates, list };
}

function addAssertion(
  steps: TestStep[],
  predicates: CasePredicates | undefined,
  anchor: string | null,
  assertion: AssertStep["assertion"],
): CaseStepsAddResult {
  const step: AssertStep = {
    id: newStepId("assert"),
    kind: "assert",
    assertion,
  };
  return {
    steps: insertAt(steps, anchor, step),
    predicates,
    addedKey: `step:${step.id}`,
  };
}

/** `insertStepAfter`, except a `null` anchor on an empty case appends. */
function insertAt(
  steps: TestStep[],
  anchor: string | null,
  step: TestStep,
): TestStep[] {
  return anchor === null
    ? [...steps, step]
    : insertStepAfter(steps, anchor, step);
}
