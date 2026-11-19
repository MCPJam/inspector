/** Keep a caller's request alive only while its human input is pending. */
export function createToolInputProgress(
  signal: AbortSignal,
  notify?: (progress: number) => Promise<unknown>,
  onError?: (error: unknown) => void
) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let progress = 0;
  let generation = 0;
  let disposed = false;
  const stop = () => {
    generation++;
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  const send = () => {
    if (signal.aborted) return stop();
    // A closed transport cannot receive heartbeats; the original request still
    // owns its error/cancellation, so stop instead of starting another call.
    const current = generation;
    void Promise.resolve()
      .then(() => {
        if (current === generation && !signal.aborted && !disposed)
          return notify?.(++progress);
        return undefined;
      })
      .catch((error: unknown) => {
        if (current === generation) {
          stop();
          onError?.(error);
        }
      });
  };
  signal.addEventListener("abort", stop, { once: true });
  return {
    setPending(pending: boolean) {
      stop();
      if (!pending || !notify || signal.aborted || disposed) return;
      send();
      timer = setInterval(send, 20_000);
    },
    dispose() {
      disposed = true;
      stop();
      signal.removeEventListener("abort", stop);
    },
  };
}
