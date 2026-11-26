/**
 * How a hosted conformance run stops before its suites finish: its time
 * budget runs out, or the run is cancelled. Either one aborts the signal the
 * suites, and every request they make, share.
 *
 * A cancel arrives through the heartbeat, as it does for readiness runs. Once
 * the backend has settled the run (cancelled it, or swept it after losing its
 * heartbeat), `conformanceRuns:heartbeat` answers `terminal`, and the run
 * stops dialling the target instead of finishing work nobody can record.
 */
import { createConformanceDeadline } from "../routes/shared/conformance-deadline.js";

export const CONFORMANCE_HEARTBEAT_INTERVAL_MS = 20_000;

export class ConformanceRunCancelledError extends Error {
  readonly code = "conformanceRunCancelled" as const;
  constructor() {
    super("The conformance run was cancelled.");
  }
}

export interface ConformanceRunLifecycle {
  /** Aborts at the deadline, with its timeout error, or on cancel. */
  signal: AbortSignal;
  /** Whether the backend settled the run while it was executing. */
  cancelled: () => boolean;
  /** Record a cancel learned some other way, such as a refused report write. */
  markCancelled: () => void;
  stop: () => void;
}

function isTerminalHeartbeat(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { ok?: unknown }).ok === false &&
    (result as { error?: unknown }).error === "terminal"
  );
}

export function startConformanceRunLifecycle(args: {
  /** Absent: no deadline beyond the backend's sweep of a silent run. */
  runTimeoutSeconds?: number;
  heartbeat: () => Promise<unknown>;
  onHeartbeatError: (error: unknown) => void;
  intervalMs?: number;
}): ConformanceRunLifecycle {
  const cancel = new AbortController();
  const deadline =
    args.runTimeoutSeconds === undefined
      ? undefined
      : createConformanceDeadline({
          runTimeoutSeconds: args.runTimeoutSeconds,
        });
  let timer: ReturnType<typeof setInterval> | undefined;
  function markCancelled() {
    if (timer !== undefined) clearInterval(timer);
    if (!cancel.signal.aborted)
      cancel.abort(new ConformanceRunCancelledError());
  }
  timer = setInterval(() => {
    void args
      .heartbeat()
      .then((result) => {
        if (isTerminalHeartbeat(result)) markCancelled();
      })
      .catch(args.onHeartbeatError);
  }, args.intervalMs ?? CONFORMANCE_HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return {
    signal: deadline
      ? AbortSignal.any([cancel.signal, deadline.signal])
      : cancel.signal,
    cancelled: () => cancel.signal.aborted,
    markCancelled,
    stop: () => {
      if (timer !== undefined) clearInterval(timer);
      deadline?.dispose();
    },
  };
}
