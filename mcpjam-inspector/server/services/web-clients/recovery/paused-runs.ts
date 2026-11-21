/**
 * Turns paused for a person, waiting in this process for the handback. A
 * handback here wakes each run it claims through `resumeWebRun`; one that
 * landed on another replica is seen when the waiting turn next reads its
 * request. Either way the turn resumes once. A turn that stops waiting leaves
 * its run paused in the backend, for a person to send again.
 */
import { logger } from "../../../utils/logger.js";
import type { PendingStep } from "./backend.js";

const waiting = new Map<string, (pendingStep: PendingStep) => void>();

export type ResumeWait = {
  signal?: AbortSignal;
  timeoutMs: number;
  pollMs: number;
  /** The run's request as the backend has it now. */
  requestStatus(): Promise<"open" | "resolved" | "cancelled" | undefined>;
};

/** The step to resume from, or undefined when the wait ended without a handback. */
export function waitForResume(
  runId: string,
  pendingStep: PendingStep,
  wait: ResumeWait,
): Promise<PendingStep | undefined> {
  return new Promise((resolve) => {
    let done = false;
    let poll: ReturnType<typeof setTimeout> | undefined;
    const finish = (step: PendingStep | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      clearTimeout(poll);
      wait.signal?.removeEventListener("abort", stop);
      if (waiting.get(runId) === finish) waiting.delete(runId);
      resolve(step);
    };
    const stop = () => finish(undefined);
    const check = () => {
      poll = setTimeout(async () => {
        try {
          const status = await wait.requestStatus();
          if (status === "resolved") return finish(pendingStep);
          if (status !== "open") return finish(undefined);
        } catch (error) {
          logger.warn(
            "[web-recovery] The paused run's request could not be read",
            {
              runId,
              message: error instanceof Error ? error.message : String(error),
            },
          );
        }
        if (!done) check();
      }, wait.pollMs);
    };
    const deadline = setTimeout(stop, wait.timeoutMs);
    if (wait.signal?.aborted) return stop();
    wait.signal?.addEventListener("abort", stop, { once: true });
    waiting.set(runId, finish);
    check();
  });
}

/** The coordinator's `resumeRun`: wakes the run's paused turn, when it waits here. */
export async function resumeWebRun(
  runId: string,
  pendingStep: PendingStep,
): Promise<void> {
  const wake = waiting.get(runId);
  if (wake) wake(pendingStep);
  else
    logger.debug("[web-recovery] No paused turn of this run waits here", {
      runId,
    });
}
