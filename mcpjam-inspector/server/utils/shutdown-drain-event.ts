/**
 * The `server.shutdown.drain` log event, one per shutdown: how much accepted
 * work this process held when the drain began and how much was still running
 * when it ended. A non-zero remainder is work still running as the teardown
 * starts, which is what deploy-loss measurement counts. Counts only, never ids.
 */
export type ShutdownDrainEvent = {
  drainMs: number;
  drainClamped: boolean;
  drained: boolean;
  waitedMs: number;
  inFlightAtStart: number;
  remainingClaimedJobs: number;
  remainingEvalRuns: number;
  remainingSwarmRuns: number;
  remainingDoorbells: number;
  remainingQuickRuns: number;
};
