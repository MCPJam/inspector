/**
 * E4 — iteration leases: who may write an eval iteration, and for how long.
 *
 * A run used to be a detached promise in ONE inspector process, so a deploy
 * killed every run in flight and the stale sweeper timed the whole thing out.
 * Leases make the ownership explicit so a run can survive its worker:
 *
 *  - the RUN has a driver token (`evalRunLeases:claimRunDriver`); a newer
 *    driver (a resume worker) supersedes an older one;
 *  - each ITERATION is claimed before it runs (`evalRunLeases:claimTestIteration`)
 *    and every write to it carries the lease token. The backend fences any
 *    write without the current token (`LEASE_LOST`), including in the gap
 *    after a release and before a reclaim — a zombie worker cannot overwrite
 *    the row a successor now owns;
 *  - the run heartbeat extends the driver's leases (never the execution
 *    deadline) and reports the iterations it no longer holds.
 *
 * Losing a lease, or being shut down, is a SILENT STOP: the local work aborts
 * and writes nothing — the backend (handback, sweeper) owns what happens to
 * the row next. Every terminal-writing path checks {@link isSilentStop}.
 *
 * Rollout flags (all default off): `MCPJAM_EVAL_ITERATION_LEASES` (E4.2) and
 * `EVAL_RESUME_ENABLED` (E4.3; requires leases).
 */
import type { ConvexHttpClient } from "convex/browser";
import { ConvexError } from "convex/values";
import { logger } from "../../utils/logger";

const ON_VALUES = new Set(["1", "true", "on", "yes"]);

/** E4.2: claim + fence iterations. */
export function iterationLeasesEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return ON_VALUES.has(
    (env.MCPJAM_EVAL_ITERATION_LEASES ?? "").trim().toLowerCase(),
  );
}

/** E4.3: mark eligible runs resumable (and run the resume worker). */
export function evalResumeEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    iterationLeasesEnabled(env) &&
    ON_VALUES.has((env.EVAL_RESUME_ENABLED ?? "").trim().toLowerCase())
  );
}

/** This process is shutting down; the run is handed back, not finished. */
export class EvalWorkerShutdownError extends Error {
  override readonly name = "EvalWorkerShutdownError";
  readonly reason = "worker_shutdown" as const;
  constructor() {
    super("Eval worker shutting down; the run is handed back for recovery.");
  }
}

/** Another driver owns this run or iteration now. Write nothing. */
export class LeaseLostError extends Error {
  override readonly name = "LeaseLostError";
  readonly reason = "lease_lost" as const;
  constructor(detail?: string) {
    super(detail ?? "This worker no longer holds the eval lease.");
  }
}

/**
 * This worker could not claim the iteration: it already finished, another
 * worker holds a live lease, or the run's deadline passed. The iteration is
 * not run here and is counted nowhere — whoever owns it records its outcome.
 */
export class IterationClaimRefusedError extends Error {
  override readonly name = "IterationClaimRefusedError";
  constructor(
    readonly iterationId: string,
    readonly reason: string,
  ) {
    super(`Iteration ${iterationId} not claimed: ${reason}`);
  }
}

/** The backend's fence refusal, in any of the shapes a client sees it. */
export function isLeaseLostError(error: unknown): boolean {
  if (error instanceof LeaseLostError) return true;
  if (error instanceof ConvexError) {
    const data = error.data as { code?: unknown } | undefined;
    if (data && typeof data === "object" && data.code === "LEASE_LOST") {
      return true;
    }
  }
  const message = error instanceof Error ? error.message : "";
  return /\bLEASE_LOST\b/.test(message);
}

/**
 * True when work stopped because this worker no longer owns it (shutdown or a
 * lost lease) — the cases in which NO terminal state may be written locally.
 */
export function isSilentStop(reason: unknown): boolean {
  return (
    reason instanceof EvalWorkerShutdownError || isLeaseLostError(reason)
  );
}

// ── Per-iteration lease tokens ────────────────────────────────────────────────
//
// Keyed by iteration id (globally unique), so every write site can attach the
// token with one spread instead of threading it through a dozen signatures.

const iterationLeases = new Map<string, { runId: string; leaseToken: string }>();

/** `{ leaseToken }` for a leased iteration, `{}` otherwise (legacy contract). */
export function leaseTokenArg(iterationId: string | undefined): {
  leaseToken?: string;
} {
  if (!iterationId) return {};
  const lease = iterationLeases.get(iterationId);
  return lease ? { leaseToken: lease.leaseToken } : {};
}

export function setIterationLease(
  iterationId: string,
  runId: string,
  leaseToken: string,
): void {
  iterationLeases.set(iterationId, { runId, leaseToken });
}

export function clearIterationLease(iterationId: string): void {
  iterationLeases.delete(iterationId);
}

/** Test seam. */
export function resetIterationLeasesForTests(): void {
  iterationLeases.clear();
}

type LeaseConvex = Pick<ConvexHttpClient, "mutation">;

export type IterationClaim =
  | { ok: true; leaseToken: string }
  | { ok: false; reason: string };

/**
 * The run's driver: its token, the iterations it currently holds, and the
 * local aborts to fire when the backend says a lease is gone.
 */
export interface RunLeaseDriver {
  readonly runId: string;
  readonly driverToken: string;
  /** Was the run accepted as resumable (E4.3)? */
  readonly resumable: boolean;
  claimIteration(
    iterationId: string,
    unitTimeoutMs: number,
  ): Promise<IterationClaim>;
  releaseIteration(iterationId: string): Promise<void>;
  /** Register the abort to fire if THIS iteration's lease is lost. */
  onIterationLost(
    iterationId: string,
    abort: (error: LeaseLostError) => void,
  ): () => void;
  /** Extra args for `testSuites:heartbeatTestSuiteRun`. */
  heartbeatArgs(): {
    driverToken: string;
    iterationTokens: Array<{ iterationId: string; leaseToken: string }>;
  };
  /** Apply a heartbeat result: abort lost iterations, or the run if superseded. */
  applyHeartbeatResult(result: unknown): void;
}

/**
 * Become the run's driver. Returns `undefined` (and the run proceeds exactly
 * as before leases existed) when the flag is off or the backend refuses or
 * predates the mutation.
 */
export async function startRunLeaseDriver(args: {
  convexClient: LeaseConvex;
  runId: string;
  /** Aborts the whole run (superseded driver). */
  abortRun: (error: LeaseLostError) => void;
  /** E4.3: ask for resumability with these facts. */
  resumable?: {
    unitTimeoutMs: number;
    executionDeadlineAt: number;
    requestScopedKeys: boolean;
    harness: boolean;
  };
  /** E4.3: a resume worker that already holds a driver token. */
  existingDriverToken?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<RunLeaseDriver | undefined> {
  const env = args.env ?? process.env;
  if (!iterationLeasesEnabled(env)) return undefined;
  let driverToken = args.existingDriverToken;
  if (!driverToken) {
    try {
      const claim = (await args.convexClient.mutation(
        "evalRunLeases:claimRunDriver" as any,
        { runId: args.runId },
      )) as { ok?: boolean; driverToken?: string } | null;
      if (!claim?.ok || typeof claim.driverToken !== "string") return undefined;
      driverToken = claim.driverToken;
    } catch (error) {
      logger.warn("[evals] could not claim run driver; running unleased", {
        runId: args.runId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  let resumable = args.existingDriverToken !== undefined;
  if (!resumable && args.resumable && evalResumeEnabled(env)) {
    try {
      const marked = (await args.convexClient.mutation(
        "evalRunLeases:markEvalRunResumable" as any,
        { runId: args.runId, driverToken, ...args.resumable },
      )) as { resumable?: boolean; reason?: string } | null;
      resumable = marked?.resumable === true;
      if (!resumable) {
        logger.info("[evals] run not resumable", {
          runId: args.runId,
          reason: marked?.reason,
        });
      }
    } catch (error) {
      logger.warn("[evals] could not mark run resumable", {
        runId: args.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return createRunLeaseDriver({
    convexClient: args.convexClient,
    runId: args.runId,
    driverToken,
    resumable,
    abortRun: args.abortRun,
  });
}

/** The driver's state machine, with Convex injected (testable). */
export function createRunLeaseDriver(args: {
  convexClient: LeaseConvex;
  runId: string;
  driverToken: string;
  resumable: boolean;
  abortRun: (error: LeaseLostError) => void;
}): RunLeaseDriver {
  const held = new Map<string, string>();
  const lostHandlers = new Map<string, (error: LeaseLostError) => void>();
  let superseded = false;

  const loseIteration = (iterationId: string, detail: string) => {
    held.delete(iterationId);
    clearIterationLease(iterationId);
    lostHandlers.get(iterationId)?.(new LeaseLostError(detail));
  };

  return {
    runId: args.runId,
    driverToken: args.driverToken,
    resumable: args.resumable,
    async claimIteration(iterationId, unitTimeoutMs) {
      if (superseded) return { ok: false, reason: "superseded" };
      try {
        const claim = (await args.convexClient.mutation(
          "evalRunLeases:claimTestIteration" as any,
          { iterationId, driverToken: args.driverToken, unitTimeoutMs },
        )) as { ok?: boolean; leaseToken?: string; reason?: string } | null;
        if (!claim?.ok || typeof claim.leaseToken !== "string") {
          return { ok: false, reason: claim?.reason ?? "refused" };
        }
        held.set(iterationId, claim.leaseToken);
        setIterationLease(iterationId, args.runId, claim.leaseToken);
        return { ok: true, leaseToken: claim.leaseToken };
      } catch (error) {
        return {
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async releaseIteration(iterationId) {
      const leaseToken = held.get(iterationId);
      held.delete(iterationId);
      lostHandlers.delete(iterationId);
      clearIterationLease(iterationId);
      if (!leaseToken) return;
      await args.convexClient
        .mutation("evalRunLeases:releaseTestIteration" as any, {
          iterationId,
          leaseToken,
        })
        .catch((error: unknown) => {
          // Best effort: an unreleased lease expires on its own.
          logger.warn("[evals] could not release iteration lease", {
            iterationId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
    onIterationLost(iterationId, abort) {
      lostHandlers.set(iterationId, abort);
      return () => {
        if (lostHandlers.get(iterationId) === abort) {
          lostHandlers.delete(iterationId);
        }
      };
    },
    heartbeatArgs() {
      return {
        driverToken: args.driverToken,
        iterationTokens: [...held].map(([iterationId, leaseToken]) => ({
          iterationId,
          leaseToken,
        })),
      };
    },
    applyHeartbeatResult(result) {
      if (!result || typeof result !== "object") return;
      const record = result as {
        driverSuperseded?: unknown;
        lostIterationIds?: unknown;
      };
      if (record.driverSuperseded === true && !superseded) {
        superseded = true;
        logger.warn("[evals] run driver superseded; stopping locally", {
          runId: args.runId,
        });
        for (const iterationId of [...held.keys()]) {
          loseIteration(iterationId, "run driver superseded");
        }
        args.abortRun(new LeaseLostError("run driver superseded"));
        return;
      }
      if (Array.isArray(record.lostIterationIds)) {
        for (const iterationId of record.lostIterationIds) {
          if (typeof iterationId === "string" && held.has(iterationId)) {
            loseIteration(iterationId, "iteration lease lost");
          }
        }
      }
    },
  };
}
