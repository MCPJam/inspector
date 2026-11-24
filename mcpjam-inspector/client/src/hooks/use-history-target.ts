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

/**
 * Ties a send to the thread open when it started. `leave()` marks a click on
 * another thread or New chat, before any discard dialog; the other ways the
 * open thread changes move `selection` or the history target. `left` is the
 * click alone: a prompt dropped while the user stayed, such as by the send's
 * own detach, goes back in the composer.
 */
export function useThreadSend<P>(
  chatSessionId: string,
  projectId: P,
  selection: { readonly current: number },
) {
  const isCurrentTarget = useHistoryTarget(chatSessionId, projectId);
  const epoch = useRef(0);
  const begin = useCallback(() => {
    const started = epoch.current;
    const selected = selection.current;
    const target = { chatSessionId, projectId };
    const left = () => epoch.current !== started;
    return {
      left,
      isCurrent: () =>
        !left() && selection.current === selected && isCurrentTarget(target),
    };
  }, [chatSessionId, projectId, selection, isCurrentTarget]);
  const leave = useCallback(() => {
    epoch.current += 1;
  }, []);
  return { isCurrentTarget, begin, leave };
}
