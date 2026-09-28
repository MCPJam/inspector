/**
 * Composes abort signals, preferring the platform `AbortSignal.any`.
 *
 * The package's engines floor is `node >= 20.0.0` but `AbortSignal.any` only
 * landed in Node 20.3.0, so this feature-detects and hand-rolls forwarding on
 * older runtimes rather than raising the floor (which would be a breaking
 * change to a published package).
 */
export function composeAbortSignals(signals: AbortSignal[]): {
  signal: AbortSignal;
  dispose: () => void;
} {
  if (signals.length === 1) {
    return { signal: signals[0], dispose: () => {} };
  }

  const nativeAny = (
    AbortSignal as unknown as {
      any?: (signals: Iterable<AbortSignal>) => AbortSignal;
    }
  ).any;
  if (typeof nativeAny === "function") {
    // `AbortSignal.any` holds its sources weakly and needs no teardown.
    return { signal: nativeAny.call(AbortSignal, signals), dispose: () => {} };
  }

  // Node 20.0–20.2 fallback: forward manually.
  const controller = new AbortController();
  const teardown: Array<() => void> = [];
  for (const source of signals) {
    if (source.aborted) {
      controller.abort(source.reason);
      break;
    }
    const onAbort = () => controller.abort(source.reason);
    source.addEventListener("abort", onAbort, { once: true });
    teardown.push(() => source.removeEventListener("abort", onAbort));
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const off of teardown) off();
      teardown.length = 0;
    },
  };
}
