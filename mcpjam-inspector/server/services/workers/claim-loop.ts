/**
 * The poll loop a background worker runs: claim one job from a
 * service-token-gated backend route, run it in this process, wait, repeat.
 *
 * What a job is, how a claim response is read, what runs a job and whether
 * the worker starts at all stay with the worker. The loop owns the timing, the
 * error backoff and shutdown. Its sleep returns at once when the stop signal
 * has already fired, so `stop()` never waits out a backoff past the server's
 * shutdown deadline.
 *
 * One job runs at a time per loop. Several replicas race safely because each
 * claim is an atomic Convex mutation.
 */
import { abortableSleep } from "../../utils/run-supervisor/backoff.js";

const POLL_INTERVAL_MS = 15_000;
/** Up to this much is added to each idle poll so replicas don't poll in step. */
const POLL_JITTER_MS = 5_000;
/**
 * After a failed claim or job, or while the feature is off backend-side, so a
 * broken or disabled backend isn't hammered.
 */
const BACKOFF_MS = 60_000;
/** After a job: another may be queued behind it. */
const AFTER_JOB_MS = 1_000;
/** After a stale entry was consumed: live work may be queued behind it. */
const AFTER_DRAINED_MS = 250;

/**
 * What one claim found: a job, or `null` when there is nothing to do.
 * `"disabled"` means the feature is off backend-side; the loop polls slowly so
 * turning it on needs no restart. `"drained"` means the claim consumed a stale
 * entry without producing work.
 */
export type ClaimResult<Job extends object> =
  | Job
  | null
  | "disabled"
  | "drained";

/**
 * The loop's three log lines. Each worker writes them with string literals:
 * the telemetry catalog only collects literal `logger.*` messages, and Axiom
 * drops a message that is not in it.
 */
export interface ClaimLoopLog {
  started(claimedBy: string): void;
  pollFailed(error: string): void;
  stopped(): void;
}

export interface ClaimLoop {
  /**
   * Stops polling and resolves once the in-flight claim, and any job it
   * returned, settles. The caller's shutdown force-exit timer bounds it; a job
   * that outlasts that timer is recovered by the backend's stale-lease sweep.
   */
  stop(): Promise<void>;
}

export function startClaimLoop<Job extends object>(worker: {
  /** `claimedBy` is this prefix plus the Railway replica id, or the pid. */
  claimedByPrefix: string;
  claim: (claimedBy: string) => Promise<ClaimResult<Job>>;
  execute: (job: Job, claimedBy: string) => Promise<void>;
  log: ClaimLoopLog;
}): ClaimLoop {
  const abort = new AbortController();
  const claimedBy = `${worker.claimedByPrefix}${
    process.env.RAILWAY_REPLICA_ID ?? process.pid
  }`;
  worker.log.started(claimedBy);

  const loop = (async () => {
    while (!abort.signal.aborted) {
      let waitMs =
        POLL_INTERVAL_MS + Math.floor(Math.random() * POLL_JITTER_MS);
      try {
        const result = await worker.claim(claimedBy);
        if (result === "disabled") {
          waitMs = BACKOFF_MS;
        } else if (result === "drained") {
          waitMs = AFTER_DRAINED_MS;
        } else if (result) {
          await worker.execute(result, claimedBy);
          waitMs = AFTER_JOB_MS;
        }
      } catch (error) {
        worker.log.pollFailed(
          error instanceof Error ? error.message : String(error),
        );
        waitMs = BACKOFF_MS;
      }
      await abortableSleep(waitMs, abort.signal);
    }
    worker.log.stopped();
  })();

  return {
    stop: async () => {
      abort.abort();
      await loop;
    },
  };
}
