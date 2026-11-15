import { useEffect, useMemo, useRef } from "react";

/** Refuse stale preparation and continuations without caching credentials. */
export function useSavedClientSendGuard(signature: string | undefined) {
  const state = useRef({ signature, generation: 0, mounted: true });
  const accepted = useRef<number | null>(null);
  if (state.current.signature !== signature) {
    state.current.signature = signature;
    state.current.generation += 1;
  }
  useEffect(() => {
    state.current.mounted = true;
    return () => {
      state.current.mounted = false;
      state.current.generation += 1;
    };
  }, []);
  return useMemo(() => ({
    begin() {
      const generation = state.current.generation;
      accepted.current = generation;
      return () => state.current.mounted && state.current.generation === generation;
    },
    cancel() {
      state.current.generation += 1;
    },
    assertCurrent() {
      if (state.current.signature === undefined) return;
      if (!state.current.mounted || (accepted.current !== null && accepted.current !== state.current.generation)) {
        throw new Error("The client or its settings changed. Send a new message to continue.");
      }
    },
  }), []);
}
