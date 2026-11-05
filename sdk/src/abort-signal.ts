/** Reject promptly on cancellation, even if the operation ignores its signal. */
export async function awaitWithSignal<T>(
  work: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) return work;
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** Keep cancellation attached through response-body reads and later requests. */
export function withAbortSignalFetch(
  fetchFn: typeof fetch,
  signal?: AbortSignal
): typeof fetch {
  if (!signal) return fetchFn;
  return (input, init) => {
    signal.throwIfAborted();
    const requestSignal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return fetchFn(input, {
      ...init,
      signal: requestSignal ? AbortSignal.any([signal, requestSignal]) : signal,
    });
  };
}
