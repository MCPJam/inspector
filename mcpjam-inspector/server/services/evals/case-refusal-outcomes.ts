import { isBearerRefusal } from "../../utils/run-bearer.js";

/** What a run summary reads from one iteration's outcome. */
type CountedOutcome = {
  evaluation: { passed: boolean };
  infraError?: unknown;
  policyBlockCount?: number;
};

/**
 * A refused job token that ended a case after some of its iterations had
 * completed, with their outcomes. A case's iteration loop has no catch, so
 * its rejection would otherwise drop them, and the run summary would count
 * the case as one failure while those rows keep their verdicts.
 *
 * It keeps the refusal's message, so it still reads as a bearer refusal
 * (`isBearerRefusal`) and the case's unstarted rows are settled the same way.
 */
export class CaseRefusedAfterIterations extends Error {
  constructor(
    refusal: Error,
    readonly completed: readonly CountedOutcome[],
  ) {
    super(refusal.message, { cause: refusal });
    this.name = refusal.name;
  }
}

/**
 * Runs a case with somewhere to keep each completed iteration's outcome, and
 * hands those outcomes on with a refused job token that ends the case.
 */
export async function keepCompletedOnRefusal<T extends CountedOutcome>(
  runCase: (completed: T[]) => Promise<T[]>,
): Promise<T[]> {
  const completed: T[] = [];
  try {
    return await runCase(completed);
  } catch (error) {
    if (isBearerRefusal(error) && completed.length > 0) {
      throw new CaseRefusedAfterIterations(error, [...completed]);
    }
    throw error;
  }
}

/** The outcomes a rejected case completed before a refused job token ended it. */
export function completedBeforeRefusal(
  reason: unknown,
): readonly CountedOutcome[] {
  return reason instanceof CaseRefusedAfterIterations ? reason.completed : [];
}

/**
 * Adds iterations' outcomes to a run summary. A trial our infrastructure
 * failed measured nothing about the server, so it is in no count, matching
 * the backend's legacy header.
 */
export function countIterationOutcomes(
  summary: {
    total: number;
    passed: number;
    failed: number;
    policyBlockedIterations: number;
  },
  outcomes: readonly CountedOutcome[],
): void {
  for (const { evaluation, infraError } of outcomes) {
    if (infraError) continue;
    summary.total += 1;
    if (evaluation.passed) {
      summary.passed += 1;
    } else {
      summary.failed += 1;
    }
  }
  summary.policyBlockedIterations += outcomes.filter(
    (outcome) => (outcome.policyBlockCount ?? 0) > 0,
  ).length;
}
