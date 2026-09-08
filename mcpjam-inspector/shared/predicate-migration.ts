import type { Predicate } from "@/shared/eval-matching";
import { isTurnScopablePredicateKind } from "@mcpjam/sdk/predicates";
import { blankPredicate, type PredicateKind } from "@/shared/predicate-kinds";
import { newStepId } from "@/shared/steps";
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

/**
 * Append scenario predicates as assert steps at the end (preserves end-of-run
 * semantics).
 *
 * The ids come from the shared minter. They used to be `migrated-assert-${i}`,
 * which COLLIDES the second time a case is migrated: the index restarts at 0
 * while the earlier steps keep those ids, so React reuses a row and
 * `removeStepById` deletes two steps at once.
 */
export function appendScenarioPredicatesAsAssertSteps(
  steps: TestStep[],
  scenarioAsserts: Predicate[],
  idKind = "assert",
): TestStep[] {
  if (scenarioAsserts.length === 0) return steps;
  return [
    ...steps,
    ...scenarioAsserts.map(
      (assertion) =>
        ({
          id: newStepId(idKind),
          kind: "assert",
          assertion,
        } satisfies AssertStep),
    ),
  ];
}

/** Remove scenario predicates from a list, keeping global gates only. */
export function stripScenarioPredicatesFromList(preds: Predicate[]): Predicate[] {
  return splitPredicatesForMigration(preds).globalGates;
}

/** `index` is kept for call-site compatibility; the id comes from the minter. */
export function newMigratedAssertStep(
  assertion: Predicate,
  _index?: number,
): AssertStep {
  return {
    id: newStepId("assert"),
    kind: "assert",
    assertion,
  };
}

export { blankPredicate, type PredicateKind as Kind };
