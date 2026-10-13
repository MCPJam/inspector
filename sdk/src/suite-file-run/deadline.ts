/**
 * The deadline every local-run setup step runs under.
 *
 * One helper, so connecting, listing tools, minting leases and resolving the
 * platform connection all get the same behaviour: the operation is handed a
 * signal that aborts when the deadline passes or the run is cancelled, and
 * the timer and the listener are released however it ends.
 */

import { SuiteFileRunError } from "./errors.js";

/** Run a setup operation under a deadline and the run's abort signal. */
export async function setupStep<T>(
  what: string,
  timeoutMs: number,
  runSignal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  runSignal.throwIfAborted();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new SuiteFileRunError({
        code: "SETUP_TIMEOUT",
        phase: "setup",
        category: "setup",
        message: `${what} did not finish within ${timeoutMs}ms.`,
      });
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    onAbort = () => {
      controller.abort(runSignal.reason);
      reject(runSignal.reason ?? new Error("aborted"));
    };
    runSignal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation(controller.signal), stopped]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) runSignal.removeEventListener("abort", onAbort);
  }
}
