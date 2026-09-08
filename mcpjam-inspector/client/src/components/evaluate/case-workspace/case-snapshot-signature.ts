/**
 * Case snapshot signature — the draft-vs-trial equality the workspace
 * overlays gate on. Step ids are stripped (they are minted per write and
 * re-derived on a promptTurns round-trip). The hasher covers task AND
 * grader because the case owns both.
 */

import {
  resolveCasePredicates,
  type CasePredicates,
  type EvalMatchOptions,
  type Predicate,
} from "@/shared/eval-matching";
import type { TestStep } from "@/shared/steps";

export type CaseSnapshotFields = {
  steps?: TestStep[] | null;
  predicates?: CasePredicates | Predicate[] | null;
  matchOptions?: EvalMatchOptions | null;
  expectedOutput?: string | null;
  isNegativeTest?: boolean;
};

function stripStepIds(steps: TestStep[]): unknown[] {
  return steps.map(({ id: _id, ...rest }) => rest);
}

function resolvedPredicates(
  predicates: CasePredicates | Predicate[] | null | undefined,
): Predicate[] {
  if (!predicates) return [];
  if (Array.isArray(predicates)) return predicates;
  return resolveCasePredicates(undefined, predicates) ?? [];
}

export function caseSnapshotSignature(input: CaseSnapshotFields): string {
  return JSON.stringify({
    steps: stripStepIds(input.steps ?? []),
    predicates: resolvedPredicates(input.predicates),
    matchOptions: input.matchOptions ?? null,
    expectedOutput: input.expectedOutput ?? "",
    isNegativeTest: input.isNegativeTest === true,
  });
}

export function signaturesMatch(
  left: CaseSnapshotFields,
  right: CaseSnapshotFields,
): boolean {
  return caseSnapshotSignature(left) === caseSnapshotSignature(right);
}
