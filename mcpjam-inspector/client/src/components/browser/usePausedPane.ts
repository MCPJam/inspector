import { useCallback, useRef, useState } from "react";

/** Where a hosted pane stands with its desktop's pause. */
export type PausedPaneState = "awake" | "paused" | "resuming";

/**
 * A hosted pane whose desktop paused for lack of use.
 *
 * The pane keeps its last picture under an overlay, and only a person wakes
 * the desktop: a click or key in the pane, or Resume. Never a timer, and never
 * a pane that is merely shown again, because watching is not use and every
 * open tab would otherwise wake it at once.
 */
export function usePausedPane(args: {
  /** Ask the control plane to wake the desktop; true once it is awake. */
  wake: () => Promise<boolean>;
  /** The desktop is awake again: reopen the picture. */
  onAwake: () => void;
}): {
  state: PausedPaneState;
  pause: () => void;
  resume: () => void;
  /** The desktop is serving again (a frame arrived) or the pane shows another browser. */
  clear: () => void;
} {
  const [state, setState] = useState<PausedPaneState>("awake");
  // Moved with every transition, not only on render, so calls from socket
  // events read the state the previous call left.
  const stateRef = useRef(state);
  const argsRef = useRef(args);
  argsRef.current = args;
  const go = useCallback((next: PausedPaneState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const pause = useCallback(() => go("paused"), [go]);
  const clear = useCallback(() => {
    if (stateRef.current !== "awake") go("awake");
  }, [go]);
  const resume = useCallback(() => {
    if (stateRef.current !== "paused") return;
    go("resuming");
    const settle = (woke: boolean) => {
      // A frame already showed the desktop serving: nothing is left to do.
      if (stateRef.current === "awake") return;
      go(woke ? "awake" : "paused");
      if (woke) argsRef.current.onAwake();
    };
    // A wake that failed leaves the box asleep; the next input asks again.
    argsRef.current.wake().then(settle, () => settle(false));
  }, [go]);
  return { state, pause, resume, clear };
}

/** How often, at most, VNC input tells the control plane someone is there. */
export const VNC_INPUT_PING_MS = 60_000;

/**
 * Report input at most once per `everyMs`. VNC input goes straight to the
 * desktop and never past the relay, so without this the control plane would
 * pause a desktop somebody is typing into.
 */
export function useThrottledInputPing(
  send: () => Promise<unknown>,
  everyMs: number = VNC_INPUT_PING_MS,
): () => void {
  const last = useRef(Number.NEGATIVE_INFINITY);
  const sendRef = useRef(send);
  sendRef.current = send;
  return useCallback(() => {
    const now = Date.now();
    if (now - last.current < everyMs) return;
    last.current = now;
    void sendRef.current();
  }, [everyMs]);
}
