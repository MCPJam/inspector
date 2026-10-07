/**
 * An App's own calls go before the host's activation work on the same App.
 *
 * Opening an entrypoint App draws it and runs the entrypoint tool at the same
 * moment, and an App usually makes its first `tools/call` within a second of
 * loading. Both requests walk the same serial chain of backend admission
 * reads, instance-control reads and receipt writes, and side by side they
 * roughly doubled each other's round trips: the App's first call took 14–16 s,
 * past the 15 s an OpenAI SDK App waits for an answer before it reports
 * "tools/call timed out". The activation call has no deadline of its own, so
 * before each of its authorization steps it waits while an App call on the
 * same instance is in flight.
 *
 * Only scheduling changes. Every step of both requests still runs, and a step
 * that waited reads fresher state, never older.
 */

/** The App waits at most this long for an answer; waiting longer than its own
 * deadline helps nobody, so it also caps one activation request's total wait. */
export const APP_CALL_YIELD_BUDGET_MS = 15_000;

const inFlight = new Map<string, Set<Promise<void>>>();

/** Run an App-origin call on `instanceToken`, visible to activation work. */
export async function runAppCall<T>(
  instanceToken: string,
  run: () => Promise<T>,
): Promise<T> {
  let settle!: () => void;
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  let calls = inFlight.get(instanceToken);
  if (!calls) inFlight.set(instanceToken, (calls = new Set()));
  calls.add(done);
  try {
    return await run();
  } finally {
    calls.delete(done);
    if (!calls.size && inFlight.get(instanceToken) === calls)
      inFlight.delete(instanceToken);
    settle();
  }
}

/**
 * One activation request's wait. Each call waits for the App calls in flight
 * at that moment (not ones that start later), and the request's waits share
 * one budget, so a busy App can delay its activation but never starve it.
 */
export function createAppCallYield(
  instanceToken: string,
  budgetMs = APP_CALL_YIELD_BUDGET_MS,
) {
  let remaining = budgetMs;
  return async (signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    const calls = inFlight.get(instanceToken);
    if (!calls?.size || remaining <= 0) return;
    const pending = [...calls];
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(resolve, remaining);
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        void Promise.all(pending).then(() => resolve());
      });
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
      remaining -= Date.now() - started;
    }
  };
}
