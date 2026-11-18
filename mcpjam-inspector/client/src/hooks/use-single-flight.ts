import { useCallback, useRef, useState } from "react";

/**
 * One task at a time. `run` refuses (resolves `undefined` without calling the
 * task) while an earlier task is still running. The ref is taken before the
 * task's first `await`, so two calls in the same tick can't both start;
 * `pending` mirrors it for the UI. Callers run inside a discrete event, so
 * `pending: true` is committed before the task resumes; after `finally` frees
 * the ref, that committed value still refuses input until the cleared state
 * renders. `settled` lets a sender that must not share the lock go after the
 * running task instead.
 */
export function useSingleFlight() {
  // Resolves when the running task ends; null while nothing runs.
  const running = useRef<Promise<void> | null>(null);
  const [pending, setPending] = useState(false);
  const run = useCallback(
    async <T>(task: () => Promise<T>): Promise<T | undefined> => {
      if (running.current) return undefined;
      let ended!: () => void;
      running.current = new Promise<void>((done) => {
        ended = done;
      });
      setPending(true);
      try {
        return await task();
      } finally {
        running.current = null;
        ended();
        setPending(false);
      }
    },
    [],
  );
  const settled = useCallback(
    () => running.current ?? Promise.resolve(),
    [],
  );
  return { pending, run, settled };
}
