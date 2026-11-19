/** Suites created from the tour's handoff whose first run hasn't started. */
const awaitingFirstRun = new Set<string>();

export function markSuiteCreatedFromTour(suiteId: string): void {
  awaitingFirstRun.add(suiteId);
}

/** Whether the suite was created from the tour and hasn't started a run yet. */
export function isAwaitingFirstRunAfterTour(suiteId: string): boolean {
  return awaitingFirstRun.has(suiteId);
}

/** True once: for the first run of a suite created from the tour. */
export function takeFirstRunAfterTour(suiteId: string): boolean {
  return awaitingFirstRun.delete(suiteId);
}

/** "Take the tour" stays offered until the project's first run. */
export function projectHasNoRuns(
  isLoading: boolean,
  suites: readonly { latestRun?: unknown }[],
): boolean {
  return !isLoading && !suites.some((entry) => entry.latestRun);
}
