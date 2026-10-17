/**
 * In-flight harness turns, so a stopping server can end them the way a Stop
 * does.
 *
 * A running harness turn holds three backend locks: its chat's session lane,
 * the box reservation, and the model-broker lease on the box. The turn's own
 * teardown releases all three. A process that exits mid-turn never runs that
 * teardown, so a deploy used to leave the chat refusing new turns ("Another
 * turn is already running") and the box refusing new runs ("A harness run is
 * already active on this computer") until each lock's TTL ran out — minutes,
 * with nothing running.
 *
 * Shutdown aborts every tracked turn, which takes the existing Stop path, and
 * waits, bounded, for each turn's teardown to finish. A crash still leaves the
 * locks to their TTLs; this covers the case a deploy causes.
 */
import { logger } from "../logger.js";

/** Inside the server's 5 s force-exit window, so the outcome is logged first. */
const HARNESS_TURN_SHUTDOWN_MS = 4_000;

export interface HarnessTurnShutdownHandle {
  /** Aborts when the server starts shutting down. */
  readonly signal: AbortSignal;
  /** Runs the turn's work and teardown; shutdown waits for it to settle. */
  track<T>(work: () => Promise<T>): Promise<T>;
}

interface TrackedHarnessTurn {
  controller: AbortController;
  done: Promise<void>;
}

const inFlightHarnessTurns = new Set<TrackedHarnessTurn>();
let shuttingDown = false;

function shutdownReason(): DOMException {
  return new DOMException("The server is shutting down", "AbortError");
}

export function createHarnessTurnShutdownHandle(): HarnessTurnShutdownHandle {
  const controller = new AbortController();
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const tracked: TrackedHarnessTurn = { controller, done };
  return {
    signal: controller.signal,
    async track(work) {
      inFlightHarnessTurns.add(tracked);
      // A turn that starts after shutdown began ends before it claims anything.
      if (shuttingDown) controller.abort(shutdownReason());
      try {
        return await work();
      } finally {
        inFlightHarnessTurns.delete(tracked);
        resolveDone();
      }
    },
  };
}

/**
 * Abort every in-flight harness turn and wait up to `timeoutMs` for their
 * teardowns. Turns that start afterwards are aborted as they begin.
 */
export async function shutdownInFlightHarnessTurns(
  timeoutMs: number = HARNESS_TURN_SHUTDOWN_MS,
): Promise<{ turns: number; settled: boolean }> {
  shuttingDown = true;
  const turns = Array.from(inFlightHarnessTurns);
  if (turns.length === 0) return { turns: 0, settled: true };
  for (const turn of turns) turn.controller.abort(shutdownReason());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const settled = await Promise.race([
    Promise.allSettled(turns.map((turn) => turn.done)).then(() => true),
    timedOut,
  ]);
  clearTimeout(timer);
  logger.info("[harness] stopped in-flight turns for shutdown", {
    turns: turns.length,
    settled,
  });
  return { turns: turns.length, settled };
}

/** Test-only: forget tracked turns and the shutting-down latch. */
export function resetHarnessTurnShutdownForTests(): void {
  inFlightHarnessTurns.clear();
  shuttingDown = false;
}
