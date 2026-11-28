/**
 * Turns paused for a person, waiting in this process for the handback. A
 * handback here wakes each run it claims through `resumeWebRun`; one that
 * landed on another replica is seen when the waiting turn next reads its
 * request. Either way the turn resumes once. A turn that stopped waiting has
 * nothing to wake: a handback here doesn't count its run as resumed, and a
 * person sends it again.
 *
 * A turn waits under its request as well as its run. Every Playground turn
 * without a chat session has the run id "playground", so one person's
 * handback must not wake another person's turn on another account.
 */
import { logger } from "../../../utils/logger.js";
import type { ClaimedRun, PendingStep } from "./backend.js";

/** A paused turn: the reconnect request it waits on, and its run. */
export type PausedRun = { requestId: string; runId: string };

/**
 * Every turn waiting on a request and run. Two Playground turns on one
 * account share both, and a handback wakes each of them.
 */
const waiting = new Map<string, Set<(pendingStep: PendingStep) => void>>();

const keyOf = ({ requestId, runId }: PausedRun) => `${requestId}:${runId}`;

export type ResumeWait = {
  signal?: AbortSignal;
  timeoutMs: number;
  pollMs: number;
  /** The run's request as the backend has it now. */
  requestStatus(): Promise<"open" | "resolved" | "cancelled" | undefined>;
};

/** The step to resume from, or undefined when the wait ended without a handback. */
export function waitForResume(
  paused: PausedRun,
  pendingStep: PendingStep,
  wait: ResumeWait,
): Promise<PendingStep | undefined> {
  const key = keyOf(paused);
  return new Promise((resolve) => {
    let done = false;
    let poll: ReturnType<typeof setTimeout> | undefined;
    const finish = (step: PendingStep | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      clearTimeout(poll);
      wait.signal?.removeEventListener("abort", stop);
      const waiters = waiting.get(key);
      waiters?.delete(finish);
      if (waiters?.size === 0) waiting.delete(key);
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
              runId: paused.runId,
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
    const waiters = waiting.get(key) ?? new Set();
    waiters.add(finish);
    waiting.set(key, waiters);
    check();
  });
}

/**
 * The coordinator's `resumeRun`: wakes the claimed run's paused turn when it
 * waits here, and answers whether one did.
 */
export async function resumeWebRun(run: ClaimedRun): Promise<boolean> {
  // A copy, since each waiter leaves the set as it wakes.
  const waiters = [...(waiting.get(keyOf(run)) ?? [])];
  for (const wake of waiters) wake(run.pendingStep);
  if (waiters.length > 0) return true;
  logger.debug("[web-recovery] No paused turn of this run waits here", {
    runId: run.runId,
    requestId: run.requestId,
  });
  return false;
}
