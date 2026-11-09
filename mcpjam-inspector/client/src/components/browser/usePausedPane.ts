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
} {
  const [state, setState] = useState<PausedPaneState>("awake");
  const stateRef = useRef(state);
  stateRef.current = state;
  const argsRef = useRef(args);
  argsRef.current = args;

  const pause = useCallback(() => setState("paused"), []);
  const resume = useCallback(() => {
    if (stateRef.current !== "paused") return;
    stateRef.current = "resuming";
    setState("resuming");
    argsRef.current.wake().then(
      (woke) => {
        if (!woke) {
          setState("paused");
          return;
        }
        setState("awake");
        argsRef.current.onAwake();
      },
      // A wake that failed leaves the box asleep; the next input asks again.
      () => setState("paused"),
    );
  }, []);
  return { state, pause, resume };
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
