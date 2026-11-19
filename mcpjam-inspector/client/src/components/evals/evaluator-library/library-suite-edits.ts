import type { Predicate } from "@mcpjam/sdk/predicates";
import type { ScorerTableScope } from "../suite-scorer-table";
import { withEvaluatorUpdated, withoutEvaluator } from "./library-catalog";

/**
 * Whole-evaluator edits for suite settings. Undefined where the rows on
 * screen are inherited and cannot be edited here.
 */
export function librarySuiteEdits(scope: ScorerTableScope) {
  if (scope.kind !== "suite") return undefined;
  return {
    predicates: scope.predicates,
    add(checks: readonly Predicate[]) {
      if (checks.length) {
        scope.onPredicatesChange((previous) => [...previous, ...checks]);
      }
    },
    remove(evaluatorId: string) {
      scope.onPredicatesChange((previous) =>
        withoutEvaluator(previous, evaluatorId),
      );
    },
    update(evaluatorId: string) {
      scope.onPredicatesChange((previous) =>
        withEvaluatorUpdated(previous, evaluatorId),
      );
    },
  };
}
