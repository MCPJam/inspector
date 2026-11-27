import { useCallback, useRef, useState } from "react";

/**
 * One task at a time. `run` refuses (resolves `undefined` without calling the
 * task) while an earlier task is still running. The ref is taken before the
 * task's first `await`, so two calls in the same tick can't both start;
 * `pending` mirrors it for the UI. Callers run inside a discrete event, so
 * `pending: true` is committed before the task resumes; after `finally` frees
 * the ref, that committed value still refuses input until the cleared state
 * renders. `cancel` aborts the task's signal and frees the lock at once; the
 * task keeps running, and its `finally` frees only a lock it still holds.
 */
export function useSingleFlight() {
  const running = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false);
  const run = useCallback(
    async <T>(
      task: (signal: AbortSignal) => Promise<T>,
    ): Promise<T | undefined> => {
      if (running.current) return undefined;
      const controller = new AbortController();
      running.current = controller;
      setPending(true);
      try {
        return await task(controller.signal);
      } finally {
        if (running.current === controller) {
          running.current = null;
          setPending(false);
        }
      }
    },
    [],
  );
  const cancel = useCallback(() => {
    running.current?.abort();
    running.current = null;
    setPending(false);
  }, []);
  return { pending, run, cancel };
}
