import { useCallback, useEffect, useRef, useState } from "react";

export type AsyncRead<T> = {
  data: T | undefined;
  /** The last read's failure. `data` keeps the last good read, so a failed poll does not blank the screen. */
  error: unknown;
  /** True until the first read answers. */
  loading: boolean;
  reload: () => void;
};

/**
 * One read, re-run when `key` changes and, while `pollMs` answers a number,
 * again after that many milliseconds. Returning `null` from `pollMs` stops
 * polling, which is how a climb that is no longer running quits asking.
 */
export function useAsyncRead<T>(
  read: (signal: AbortSignal) => Promise<T>,
  /** Names what is read: a new key reads again. */
  key: string,
  options: {
    enabled?: boolean;
    pollMs?: (data: T | undefined) => number | null;
  } = {},
): AsyncRead<T> {
  const { enabled = true } = options;
  const [state, setState] = useState<{ data: T | undefined; error: unknown; loading: boolean }>({
    data: undefined,
    error: undefined,
    loading: enabled,
  });
  const [tick, setTick] = useState(0);
  const readRef = useRef(read);
  readRef.current = read;
  const pollRef = useRef(options.pollMs);
  pollRef.current = options.pollMs;

  useEffect(() => {
    if (!enabled) {
      setState({ data: undefined, error: undefined, loading: false });
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState((previous) => ({ ...previous, loading: previous.data === undefined }));

    let latest: T | undefined;
    const run = async () => {
      try {
        latest = await readRef.current(controller.signal);
        if (controller.signal.aborted) return;
        setState({ data: latest, error: undefined, loading: false });
      } catch (error) {
        if (controller.signal.aborted) return;
        setState((previous) => ({ data: previous.data, error, loading: false }));
      }
      const wait = pollRef.current?.(latest);
      if (typeof wait === "number" && !controller.signal.aborted) {
        timer = setTimeout(run, wait);
      }
    };
    void run();

    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [enabled, tick, key]);

  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { ...state, reload };
}
