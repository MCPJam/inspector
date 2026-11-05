import { useCallback, useRef, useState } from "react";

/**
 * One task at a time. `run` refuses (resolves `undefined` without calling the
 * task) while an earlier task is still running. The ref is taken before the
 * task's first `await`, so two calls in the same tick can't both start;
 * `pending` mirrors it for the UI.
 */
export function useSingleFlight() {
  const running = useRef(false);
  const [pending, setPending] = useState(false);
  const run = useCallback(
    async <T>(task: () => Promise<T>): Promise<T | undefined> => {
      if (running.current) return undefined;
      running.current = true;
      setPending(true);
      try {
        return await task();
      } finally {
        running.current = false;
        setPending(false);
      }
    },
    [],
  );
  return { pending, run };
}
