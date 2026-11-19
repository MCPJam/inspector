/**
 * Wakes a Send waiting out a box preparation (`box-preparing-wait.ts`) as soon
 * as a preparation on this instance hands its claim back, instead of after the
 * rest of its backoff pause. A preparation on another instance never signals
 * here, so that Send keeps its backoff. On only with `MCPJAM_HARNESS_PREP_WAKE=1`
 * (read per call).
 */

export function preparationWakeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MCPJAM_HARNESS_PREP_WAKE === "1";
}

/** A release this recent still wakes a wait that starts just after it. */
const RECENT_MS = 5_000;
const MAX_RECENT = 500;

const waiters = new Map<string, Set<() => void>>();
const settledAt = new Map<string, number>();

/** A preparation of `boxId` has handed its claim back, however it ended. */
export function markBoxPreparationSettled(boxId: string, now: number = Date.now()): void {
  settledAt.delete(boxId);
  settledAt.set(boxId, now);
  if (settledAt.size > MAX_RECENT) {
    const oldest = settledAt.keys().next().value;
    if (oldest !== undefined) settledAt.delete(oldest);
  }
  const waiting = waiters.get(boxId);
  waiters.delete(boxId);
  for (const wake of waiting ?? []) wake();
}

/**
 * Wait up to `ms`, ending early when a preparation of `boxId` settles, or at
 * once when one settled within the last few seconds. Rejects on `signal`.
 */
export function waitForBoxPreparation(
  boxId: string,
  ms: number,
  signal?: AbortSignal,
  now: number = Date.now(),
): Promise<void> {
  const settled = settledAt.get(boxId);
  if (settled !== undefined && now - settled < RECENT_MS) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const wake = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      waiters.get(boxId)?.delete(wake);
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      waiters.get(boxId)?.delete(wake);
      reject(signal?.reason);
    };
    const timer = setTimeout(wake, ms);
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    let set = waiters.get(boxId);
    if (!set) {
      set = new Set();
      waiters.set(boxId, set);
    }
    set.add(wake);
  });
}
