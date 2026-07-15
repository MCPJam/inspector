import type { Predicate } from "@/shared/eval-matching";
import { isTurnScopablePredicateKind } from "@mcpjam/sdk/predicates";
import { blankPredicate, type PredicateKind } from "@/shared/predicate-kinds";
import type { AssertStep, TestStep } from "@/shared/steps";

/** Split predicates into global gates vs scenario asserts for migration UX. */
export function splitPredicatesForMigration(preds: Predicate[]): {
  globalGates: Predicate[];
  scenarioAsserts: Predicate[];
} {
  const globalGates: Predicate[] = [];
  const scenarioAsserts: Predicate[] = [];
  for (const p of preds) {
    if (p.type === "tokenBudgetUnder" || !isTurnScopablePredicateKind(p.type)) {
      globalGates.push(p);
    } else {
      scenarioAsserts.push(p);
    }
  }
  return { globalGates, scenarioAsserts };
}

/** Append scenario predicates as assert steps at the end (preserves end-of-run semantics). */
export function appendScenarioPredicatesAsAssertSteps(
  steps: TestStep[],
  scenarioAsserts: Predicate[],
  idPrefix = "migrated-assert",
): TestStep[] {
  if (scenarioAsserts.length === 0) return steps;
  const next = [...steps];
  scenarioAsserts.forEach((assertion, i) => {
    next.push({
      id: `${idPrefix}-${i}`,
      kind: "assert",
      assertion,
    } satisfies AssertStep);
  });
  return next;
}

/** Remove scenario predicates from a list, keeping global gates only. */
export function stripScenarioPredicatesFromList(preds: Predicate[]): Predicate[] {
  return splitPredicatesForMigration(preds).globalGates;
}

export function newMigratedAssertStep(
  assertion: Predicate,
  index: number,
): AssertStep {
  return {
    id: `migrated-assert-${index}`,
    kind: "assert",
    assertion,
  };
}

export { blankPredicate, type PredicateKind as Kind };
