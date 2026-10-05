/**
 * E4.0 — every suite run executing in this process, and what happens to them
 * when the process stops.
 *
 * Before this, a deploy's SIGTERM drained swarm runs only; an eval run was a
 * detached promise that simply died with the process, and the stale sweeper
 * later timed the WHOLE run out — including cases that had already finished.
 *
 * On shutdown each registered run is:
 *
 *  1. aborted with {@link EvalWorkerShutdownError} — a silent stop: no local
 *     terminal writes, and the runner's own `finally` blocks release eval
 *     sandboxes and revoke harness broker leases while it unwinds;
 *  2. given a bounded window to settle (`graceMs`);
 *  3. then handed to the backend, which owns the outcome:
 *     - RESUMABLE (E4.3): `evalRunLeases:handBackEvalRun` — completed rows are
 *       kept, replay-safe interrupted rows requeue for a resume worker, unsafe
 *       ones become `failed` + `infraError{worker_lost}` (excluded, refunded);
 *     - otherwise: `evalRunLeases:terminalizeInterruptedRun` — every
 *       unfinished row becomes `failed` + `infraError{worker_lost}` and the
 *       run finalizes, so a deploy is honest about what it interrupted.
 *
 * Nothing here depends on `finally` running: a SIGKILL, or an exhausted grace
 * period, converges through the backend's stale-run watchdog and the sandbox
 * reconciler instead.
 *
 * Rollout: `MCPJAM_EVAL_SHUTDOWN_HANDOFF=1` (E4.0, off by default).
 */
import type { ConvexHttpClient } from "convex/browser";
import { logger } from "../../utils/logger";
import {
  EvalWorkerShutdownError,
  type RunLeaseDriver,
} from "./run-lease";

export type ActiveEvalRun = {
  runId: string;
  suiteId: string;
  convexClient: Pick<ConvexHttpClient, "mutation">;
  /** Abort the run's work with the given reason. */
  abort: (reason: Error) => void;
  /** Resolves once the run's promise has settled (registry-owned). */
  settled: Promise<void>;
  /** The run's lease driver, when leases are on. */
  lease?: () => RunLeaseDriver | undefined;
};

/** `MCPJAM_EVAL_SHUTDOWN_HANDOFF` (E4.0) — off by default. */
export function evalShutdownHandoffEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return ["1", "true", "on", "yes"].includes(
    (env.MCPJAM_EVAL_SHUTDOWN_HANDOFF ?? "").trim().toLowerCase(),
  );
}

const activeRuns = new Map<string, ActiveEvalRun>();
let shuttingDown = false;

/** Register a run; the returned function unregisters it. */
export function registerActiveEvalRun(
  run: Omit<ActiveEvalRun, "settled">,
): { settle: () => void; isShuttingDown: () => boolean } {
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const entry: ActiveEvalRun = { ...run, settled };
  activeRuns.set(run.runId, entry);
  // A run that registers DURING shutdown is stopped immediately.
  if (shuttingDown) run.abort(new EvalWorkerShutdownError());
  return {
    settle: () => {
      if (activeRuns.get(run.runId) === entry) activeRuns.delete(run.runId);
      settle();
    },
    isShuttingDown: () => shuttingDown,
  };
}

export function activeEvalRunCount(): number {
  return activeRuns.size;
}

export function isEvalWorkerShuttingDown(): boolean {
  return shuttingDown;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export type EvalShutdownSummary = {
  runs: number;
  handedBack: number;
  terminalized: number;
  /** Left to the watchdog (backend call failed or timed out). */
  unresolved: number;
};

/**
 * Stop every registered run and hand each to the backend. Bounded: the
 * whole thing finishes within roughly `graceMs + callTimeoutMs`.
 */
export async function shutdownActiveEvalRuns(options?: {
  graceMs?: number;
  callTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<EvalShutdownSummary> {
  // The E4.0 rollout flag, off by default: without it runs die with the
  // process as before, and the stale-run watchdog times them out.
  if (!evalShutdownHandoffEnabled(options?.env)) {
    return {
      runs: activeRuns.size,
      handedBack: 0,
      terminalized: 0,
      unresolved: activeRuns.size,
    };
  }
  shuttingDown = true;
  const graceMs = options?.graceMs ?? 8_000;
  const callTimeoutMs = options?.callTimeoutMs ?? 5_000;
  const runs = [...activeRuns.values()];
  const summary: EvalShutdownSummary = {
    runs: runs.length,
    handedBack: 0,
    terminalized: 0,
    unresolved: 0,
  };
  if (runs.length === 0) return summary;
  logger.info("[evals] shutting down active eval runs", {
    runs: runs.length,
  });

  for (const run of runs) run.abort(new EvalWorkerShutdownError());
  // Let the runners unwind — sandboxes released, broker leases revoked —
  // inside ONE shared window, not one window per run.
  await withTimeout(
    Promise.allSettled(runs.map((run) => run.settled)),
    graceMs,
  );

  await Promise.all(
    runs.map(async (run) => {
      const lease = run.lease?.();
      try {
        if (lease?.resumable) {
          const result = await withTimeout(
            run.convexClient.mutation("evalRunLeases:handBackEvalRun" as any, {
              runId: run.runId,
              driverToken: lease.driverToken,
              reason: "worker_shutdown",
            }) as Promise<{ ok?: boolean } | null>,
            callTimeoutMs,
          );
          if (result !== "timeout" && result?.ok) {
            summary.handedBack += 1;
            return;
          }
        } else {
          const result = await withTimeout(
            run.convexClient.mutation(
              "evalRunLeases:terminalizeInterruptedRun" as any,
              {
                runId: run.runId,
                ...(lease ? { driverToken: lease.driverToken } : {}),
                reason: "worker_shutdown",
              },
            ) as Promise<{ ok?: boolean } | null>,
            callTimeoutMs,
          );
          if (result !== "timeout" && result?.ok) {
            summary.terminalized += 1;
            return;
          }
        }
        summary.unresolved += 1;
      } catch (error) {
        summary.unresolved += 1;
        logger.warn("[evals] shutdown handoff failed; watchdog will converge", {
          runId: run.runId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );
  logger.info("[evals] eval run shutdown complete", summary);
  return summary;
}

/** Test seam. */
export function resetActiveEvalRunsForTests(): void {
  activeRuns.clear();
  shuttingDown = false;
}
