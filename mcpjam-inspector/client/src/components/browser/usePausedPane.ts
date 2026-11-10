import { useCallback, useEffect, useRef, useState } from "react";

/** Where a hosted pane stands with its desktop's pause. */
export type PausedPaneState = "awake" | "paused" | "resuming";

/** How often a paused pane on screen asks whether something else woke it. */
export const PAUSED_CHECK_MS = 10_000;

/**
 * A hosted pane whose desktop paused for lack of use.
 *
 * The pane keeps its last picture under an overlay, and only a person wakes
 * the desktop: a click or key in the pane, or Resume. Never a timer, and never
 * a pane that is merely shown again, because watching is not use and every
 * open tab would otherwise wake it at once.
 *
 * Something else can wake it, though: the agent's next browser command does.
 * The socket closed at the pause, so nothing would tell the pane. While it is
 * paused AND on screen it asks `isServing`, a read that never wakes anything,
 * and reopens the picture once the desktop serves again.
 */
export function usePausedPane(args: {
  /** Ask the control plane to wake the desktop; true once it is awake. */
  wake: () => Promise<boolean>;
  /** The desktop is awake again: reopen the picture. */
  onAwake: () => void;
  /** Is the desktop serving again? A read only: it must never wake it. */
  isServing?: () => Promise<boolean>;
  /** Is the pane on screen? A hidden pane asks nothing. */
  visible?: boolean;
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

  // Only while paused: a person's wake in flight already owns the outcome.
  const watching =
    state === "paused" && (args.visible ?? true) && !!args.isServing;
  useEffect(() => {
    if (!watching) return;
    let stopped = false;
    let asking = false;
    const timer = setInterval(() => {
      const isServing = argsRef.current.isServing;
      if (asking || !isServing || document.visibilityState !== "visible")
        return;
      asking = true;
      const settle = (serving: boolean) => {
        asking = false;
        if (stopped || !serving || stateRef.current !== "paused") return;
        go("awake");
        argsRef.current.onAwake();
      };
      isServing().then(settle, () => settle(false));
    }, PAUSED_CHECK_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [watching, go]);

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
