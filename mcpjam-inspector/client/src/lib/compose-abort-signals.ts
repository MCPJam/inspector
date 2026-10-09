/** Combine cancellation signals without requiring AbortSignal.any support. */
export function composeAbortSignals(signals: AbortSignal[]): {
  signal: AbortSignal;
  dispose: () => void;
} {
  if (signals.length === 1) {
    return { signal: signals[0], dispose: () => {} };
  }
  if (typeof AbortSignal.any === "function") {
    return { signal: AbortSignal.any(signals), dispose: () => {} };
  }

  const controller = new AbortController();
  const aborted = signals.find((signal) => signal.aborted);
  if (aborted) {
    controller.abort(aborted.reason);
    return { signal: controller.signal, dispose: () => {} };
  }

  const cleanup: Array<() => void> = [];
  const dispose = () => {
    for (const remove of cleanup) remove();
    cleanup.length = 0;
  };
  for (const source of signals) {
    const onAbort = () => {
      controller.abort(source.reason);
      dispose();
    };
    source.addEventListener("abort", onAbort, { once: true });
    cleanup.push(() => source.removeEventListener("abort", onAbort));
  }
  return { signal: controller.signal, dispose };
}
