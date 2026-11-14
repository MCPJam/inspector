import { useCallback, useLayoutEffect, useRef } from "react";

/** The conversation a chat-history read was issued for. */
export interface HistoryTarget<P> {
  chatSessionId: string;
  projectId: P;
}

/**
 * Whether the thread a history read was issued for is still the open one.
 * A read can land after the user opened another thread (a pre-send read
 * outlives its timeout); its result must never attach that thread's row or
 * cursor to the thread now open, nor detach it. The open thread is recorded
 * after commit, so a render React discards cannot move it.
 */
export function useHistoryTarget<P>(
  chatSessionId: string,
  projectId: P,
): (target: HistoryTarget<P>) => boolean {
  const open = useRef<HistoryTarget<P>>({ chatSessionId, projectId });
  useLayoutEffect(() => {
    open.current = { chatSessionId, projectId };
  }, [chatSessionId, projectId]);
  return useCallback(
    (target: HistoryTarget<P>) =>
      open.current.chatSessionId === target.chatSessionId &&
      open.current.projectId === target.projectId,
    [],
  );
}
