import { heartbeatHarnessSessionState, type HarnessOwnerRef } from "./harness-session-state.js";
import { logger } from "../logger.js";

/** Refresh authorization per beat; a stopped loop cannot abort a later turn. */
export function startLeaseHeartbeat(args: {
  owner: HarnessOwnerRef;
  leaseId: string;
  leaseTtlMs: number;
  intervalMs: number;
  timeoutMs: number;
  getAuthorization(): Promise<string>;
  onLost(error: Error): void;
}): () => void {
  let stopped = false;
  let inFlight = false;
  let firstRetryableAt = 0;
  const controller = new AbortController();
  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    inFlight = true;
    void args.getAuthorization().then((bearer) => {
      if (stopped) return undefined;
      return heartbeatHarnessSessionState({
        owner: args.owner, leaseId: args.leaseId, leaseTtlMs: args.leaseTtlMs, bearer,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(args.timeoutMs)]),
      });
    }).then((result) => {
      if (stopped || result === undefined) return;
      if (result === "ok") { firstRetryableAt = 0; return; }
      if (result === "lost") {
        logger.warn("[harness] lease lost — aborting turn", { leaseId: args.leaseId });
        args.onLost(new Error("harness lease lost"));
        return;
      }
      if (firstRetryableAt === 0) firstRetryableAt = Date.now();
      const elapsedMs = Date.now() - firstRetryableAt;
      logger.warn("[harness] heartbeat transient failure; will retry", { elapsedMs });
      if (elapsedMs >= args.leaseTtlMs)
        args.onLost(new Error("harness lost liveness"));
    }).catch((error: unknown) => {
      if (stopped) return;
      logger.warn("[harness] lease authorization failed", {
        reason: error instanceof Error ? error.name : "unknown",
      });
      args.onLost(new Error("Harness authorization could not be renewed. Sign in and start a new turn."));
    }).finally(() => { inFlight = false; });
  }, args.intervalMs);
  timer.unref?.();
  return () => { stopped = true; clearInterval(timer); controller.abort(); };
}
