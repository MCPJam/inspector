import { useCallback, useRef, useState } from "react";

/**
 * State that an async callback can read without going stale: the setter
 * writes the ref before React renders, so code resuming after an `await`
 * sees the latest value, not the one from the render that started it.
 */
export function useStateWithRef<T>(initial: T) {
  const [state, setState] = useState(initial);
  const ref = useRef(initial);
  const set = useCallback((next: T) => {
    ref.current = next;
    setState(next);
  }, []);
  return [state, set, ref] as const;
}
