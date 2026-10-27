type PrecreatedIterationSnapshot = {
  title?: string;
  query?: string;
  model?: string;
  provider?: string;
};

type PrecreatedIterationRow = {
  _id?: string;
  testCaseId?: string;
  iterationNumber?: number;
  testCaseSnapshot?: PrecreatedIterationSnapshot;
};

/**
 * The pre-created row an iteration runs against. Rows of a suite run carry the
 * case id, so pair by case, iteration and (with a snapshot) model: the stored
 * query is the case's first prompt, while the runner synthesizes one for a
 * case that starts with a tool call (PLB-407). Rows without a case id
 * (replays of SDK runs) keep the snapshot text rule.
 */
export function findPrecreatedIterationByCase<T extends PrecreatedIterationRow>(
  iterations: T[],
  {
    testCaseId,
    testCaseSnapshot,
    iterationNumber,
  }: {
    testCaseId?: string;
    testCaseSnapshot?: PrecreatedIterationSnapshot;
    iterationNumber: number;
  },
): T | undefined {
  return iterations.find((iter) => {
    if (iter.iterationNumber !== iterationNumber) return false;
    const stored = iter.testCaseSnapshot;
    const sameModel =
      !testCaseSnapshot ||
      !stored ||
      (stored.model === testCaseSnapshot.model &&
        stored.provider === testCaseSnapshot.provider);
    if (testCaseId && iter.testCaseId) {
      return iter.testCaseId === testCaseId && sameModel;
    }
    if (testCaseSnapshot && stored) {
      return (
        sameModel &&
        stored.title === testCaseSnapshot.title &&
        stored.query === testCaseSnapshot.query
      );
    }
    return iter.testCaseId === testCaseId;
  });
}
