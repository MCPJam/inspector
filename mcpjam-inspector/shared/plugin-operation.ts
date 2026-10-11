/** Stop waiting promptly while fencing any late work with the same signal. */
export async function waitForPluginOperation<T>(
  signal: AbortSignal,
  effect: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return effect();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

/**
 * A failure already described in plain English for the person in front of
 * the surface. Forms show its message as is; `code` names it in Logs.
 */
export class PluginDescribedError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "PluginDescribedError";
  }
}

/**
 * Wait at most `ms` for `effect`, even when the effect itself can't be
 * cancelled. At the deadline the signal handed to the effect aborts and the
 * wait rejects with `expired()`. `pause` stops the clock while the person
 * decides something (an approval) and restarts it in full afterwards.
 */
export async function withPluginDeadline<T>(
  signal: AbortSignal,
  ms: number,
  expired: () => Error,
  effect: (
    bounded: AbortSignal,
    pause: <R>(wait: () => Promise<R>) => Promise<R>,
  ) => Promise<T>,
): Promise<T> {
  const deadline = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => deadline.abort(expired()), ms);
  };
  const bounded = AbortSignal.any([signal, deadline.signal]);
  arm();
  try {
    return await waitForPluginOperation(bounded, () =>
      effect(bounded, async (wait) => {
        clearTimeout(timer);
        try {
          return await wait();
        } finally {
          if (!bounded.aborted) arm();
        }
      }),
    );
  } finally {
    clearTimeout(timer);
  }
}
