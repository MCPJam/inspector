/**
 * The bounded drain a server runs between a shutdown signal and its teardown.
 *
 * Work this process already accepted (a detached eval run, a swarm run, a
 * claimed job, a doorbell pass) registers here. Once a drain begins, routes
 * that would start new work refuse it, and the drain waits for the registered
 * work to settle or for its deadline, whichever comes first. Only then does
 * the server close what that work depends on (MCP connections, tunnels,
 * browser sessions, the HTTP listener): tearing those down first would turn a
 * graceful drain into the very interruption it exists to avoid.
 *
 * Work still running when the deadline passes is cut off by the teardown that
 * follows, exactly as before; the backend's stale-run and stale-lease sweeps
 * remain the recovery path for it.
 */

export type InFlightKind =
  "claimed_job" | "eval_run" | "swarm_run" | "doorbell" | "quick_run";

export type InFlightCounts = Partial<Record<InFlightKind, number>>;

export type DrainResult = {
  /** Nothing registered was still running when the drain ended. */
  drained: boolean;
  waitedMs: number;
  inFlightAtStart: InFlightCounts;
  remaining: InFlightCounts;
};

export function createDrainCoordinator(now: () => number = Date.now) {
  let draining = false;
  let nextId = 0;
  const inFlight = new Map<
    number,
    { kind: InFlightKind; settled: Promise<void> }
  >();

  function counts(): InFlightCounts {
    const out: InFlightCounts = {};
    for (const { kind } of inFlight.values()) out[kind] = (out[kind] ?? 0) + 1;
    return out;
  }

  return {
    isDraining: () => draining,

    /** Stop admitting new work. Idempotent; `drain` calls it too. */
    begin: () => {
      draining = true;
    },

    /**
     * Register accepted work so a drain waits for it. Returns the same promise,
     * so a call site can wrap the work it already started. Watching `work`
     * marks its rejection handled, so it never reaches the server's
     * `unhandledRejection` report: the caller must attach its own `.catch`.
     */
    track<T>(kind: InFlightKind, work: Promise<T>): Promise<T> {
      const id = nextId++;
      const settled = work.then(
        () => undefined,
        // Its owner handles the failure; the drain only needs to know it ended.
        () => undefined,
      );
      inFlight.set(id, { kind, settled });
      void settled.then(() => inFlight.delete(id));
      return work;
    },

    counts,

    /**
     * Stop admitting new work and wait, up to `deadlineMs`, for registered work
     * to settle. Work registered while waiting (a claimed job finishing its
     * last step, a swarm session already under way) is waited for too, and so
     * is `registering`: until it settles, whatever is still being accepted (a
     * claim answered after the claim loops were told to stop) can register.
     */
    async drain(
      deadlineMs: number,
      registering?: Promise<unknown>,
    ): Promise<DrainResult> {
      draining = true;
      const startedAt = now();
      const inFlightAtStart = counts();
      let open = registering !== undefined;
      const close = () => {
        open = false;
      };
      // A failure is its owner's to report; here it only ends the registering.
      const closed = registering?.then(close, close);
      while (open || inFlight.size > 0) {
        const leftMs = startedAt + deadlineMs - now();
        if (leftMs <= 0) break;
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          Promise.all([
            closed,
            ...[...inFlight.values()].map((entry) => entry.settled),
          ]),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, leftMs);
          }),
        ]);
        clearTimeout(timer);
      }
      return {
        drained: inFlight.size === 0,
        waitedMs: now() - startedAt,
        inFlightAtStart,
        remaining: counts(),
      };
    },
  };
}

export type DrainCoordinator = ReturnType<typeof createDrainCoordinator>;

/** This process's drain. */
export const serverDrain: DrainCoordinator = createDrainCoordinator();
