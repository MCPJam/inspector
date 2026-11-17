/** Suites created from the tour's handoff whose first run hasn't started. */
const awaitingFirstRun = new Set<string>();

export function markSuiteCreatedFromTour(suiteId: string): void {
  awaitingFirstRun.add(suiteId);
}

/** True once: for the first run of a suite created from the tour. */
export function takeFirstRunAfterTour(suiteId: string): boolean {
  return awaitingFirstRun.delete(suiteId);
}
