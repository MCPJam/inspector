/**
 * Rings this server's own drain-style doorbells on a timer.
 *
 * The backend wakes a peer by POSTing to `INSPECTOR_INTERNAL_ORIGIN` when
 * durable agent turns or chat-session stage derivations are owed. An Inspector
 * running on a laptop or in a cloud agent's sandbox, against its own
 * disposable backend, has no address that backend can reach, so nothing would
 * ever ring and that work would never run. With `MCPJAM_LOCAL_DOORBELL_MS`
 * set, this loop runs the same passes the doorbell routes run.
 *
 * Both passes claim from the backend's own queue, so a ring with nothing owed
 * is one cheap round trip, and a ring the backend also sent is harmless.
 * Doorbells that carry a selector (server-connection requests, judge
 * completions) can't be replayed from here and are not covered.
 */

import { runDurableAgentPass } from "../routes/internal/agent-turns.js";
import { runChatSessionStagePass } from "./chat-stage/chat-session-stage-pass.js";
import { serverDrain, type DrainCoordinator } from "./lifecycle/drain.js";
import { abortableSleep } from "../utils/run-supervisor/backoff.js";
import { logger } from "../utils/logger";

const MIN_INTERVAL_MS = 1_000;

export interface DoorbellPass {
  name: string;
  run: () => Promise<unknown>;
}

const DOORBELL_PASSES: DoorbellPass[] = [
  { name: "agent-turns", run: runDurableAgentPass },
  { name: "chat-stage", run: runChatSessionStagePass },
];

/** The interval, or null when the doorbell is off or misconfigured. */
export function localDoorbellIntervalMs(
  value: string | undefined = process.env.MCPJAM_LOCAL_DOORBELL_MS,
): number | null {
  if (!value) return null;
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms < MIN_INTERVAL_MS) {
    logger.warn(
      `[local-doorbell] MCPJAM_LOCAL_DOORBELL_MS must be a whole number of milliseconds, at least ${MIN_INTERVAL_MS}; not starting`,
    );
    return null;
  }
  return ms;
}

export interface LocalDoorbellHandle {
  /** Ends the loop once the pass in flight (if any) settles. */
  stop: () => Promise<void>;
}

export function startLocalDoorbell(
  intervalMs: number,
  options?: { passes?: DoorbellPass[]; drain?: DrainCoordinator },
): LocalDoorbellHandle {
  const passes = options?.passes ?? DOORBELL_PASSES;
  const drain = options?.drain ?? serverDrain;
  const abort = new AbortController();
  // A misconfigured pass fails on every ring; log each new failure once.
  const lastFailure = new Map<string, string>();
  logger.info("[local-doorbell] started", {
    intervalMs,
    passes: passes.map((pass) => pass.name),
  });

  const loop = (async () => {
    while (!abort.signal.aborted) {
      // Wait first: at startup the server isn't listening yet, and the agent
      // pass dispatches its steps back to this server.
      await abortableSleep(intervalMs, abort.signal);
      if (abort.signal.aborted) break;
      if (!drain.isDraining()) {
        // One at a time: overlapping passes would only contend for the
        // same leases.
        for (const pass of passes) {
          try {
            await drain.track("doorbell", pass.run());
            if (lastFailure.delete(pass.name)) {
              logger.info(`[local-doorbell] ${pass.name} pass recovered`);
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            if (lastFailure.get(pass.name) !== message) {
              lastFailure.set(pass.name, message);
              logger.warn(`[local-doorbell] ${pass.name} pass failed`, {
                error: message,
              });
            }
          }
        }
      }
    }
    logger.info("[local-doorbell] stopped");
  })();

  return {
    stop: async () => {
      abort.abort();
      await loop;
    },
  };
}
