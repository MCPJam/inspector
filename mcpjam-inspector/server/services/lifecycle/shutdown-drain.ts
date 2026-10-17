import { logger } from "../../utils/logger.js";
import { getSystemLogger } from "../../utils/request-logger.js";
import type { BackgroundWorkers } from "../background-workers.js";
import { serverDrain, type DrainCoordinator } from "./drain.js";

/**
 * The first step of shutdown: stop admitting and claiming new work, then let
 * accepted work finish for up to `drainMs` before the teardown closes what it
 * depends on. Each claim loop registers the job it runs with the drain, so
 * stopping the loops only has to stop the claiming.
 */
export async function drainBeforeTeardown(
  workers: BackgroundWorkers,
  settings: { drainMs: number; drainClamped: boolean },
  drain: DrainCoordinator = serverDrain,
): Promise<void> {
  drain.begin();
  const loopsStopped = workers.stop();
  if (settings.drainMs > 0) {
    // The drain alone decides what the teardown waits for: a loop still
    // winding down (a claim answered after the stop) cannot hold it past the
    // deadline, and a stop that fails, during the drain or after it, is still
    // reported.
    loopsStopped.catch((error: unknown) => {
      logger.warn("[shutdown] a claim loop failed to stop", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  const result = await drain.drain(settings.drainMs);
  getSystemLogger("shutdown").event("server.shutdown.drain", {
    drainMs: settings.drainMs,
    drainClamped: settings.drainClamped,
    drained: result.drained,
    waitedMs: result.waitedMs,
    inFlightAtStart: Object.values(result.inFlightAtStart).reduce(
      (sum, count) => sum + count,
      0,
    ),
    remainingClaimedJobs: result.remaining.claimed_job ?? 0,
    remainingEvalRuns: result.remaining.eval_run ?? 0,
    remainingSwarmRuns: result.remaining.swarm_run ?? 0,
    remainingDoorbells: result.remaining.doorbell ?? 0,
    remainingQuickRuns: result.remaining.quick_run ?? 0,
  });
  // With no drain configured, claimed jobs keep the grace they always had:
  // shutdown waits for them, bounded only by the force-exit timer. Awaiting
  // also surfaces a failed stop, which fails the shutdown as it always has.
  if (settings.drainMs <= 0) await loopsStopped;
}
