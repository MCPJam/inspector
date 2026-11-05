import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/** Host visibility is independent from the App's negotiated display mode. */
export function useFullscreenDismissal(args: {
  fullscreen: boolean;
  enabled: boolean;
  canInline: boolean;
  unowned: boolean;
  hostInputPending: boolean;
  element: () => HTMLElement | null;
  inline: () => void;
  exit: () => void;
  open: () => void;
}) {
  const current = useRef(args);
  current.current = args;
  const [dismissed, setDismissed] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const pending = useRef(new Set<symbol>());
  const collapsed =
    args.enabled &&
    args.fullscreen &&
    (dismissed || (!args.canInline && args.unowned));
  const conceal = useCallback(() => {
    const value = current.current;
    if (!value.enabled || !value.fullscreen) return;
    setDismissed(true);
    value.exit();
  }, []);
  const dismiss = useCallback(() => {
    const value = current.current;
    if (!value.enabled || !value.fullscreen) return;
    if (value.canInline) value.inline();
    else conceal();
  }, [conceal]);
  const open = useCallback(() => {
    if (pending.current.size || current.current.hostInputPending) return;
    setDismissed(false);
    current.current.open();
  }, []);
  useEffect(() => {
    if (!args.fullscreen || !args.enabled) setDismissed(false);
  }, [args.fullscreen, args.enabled]);
  useLayoutEffect(() => {
    if (args.hostInputPending || pendingCount > 0) conceal();
  }, [
    args.hostInputPending,
    args.fullscreen,
    args.enabled,
    pendingCount,
    conceal,
  ]);
  useEffect(() => {
    if (!args.enabled || !args.fullscreen || collapsed) return;
    const keydown = (event: KeyboardEvent) => {
      // The focused owner handles Escape; another Compare lane must not close.
      const element = current.current.element();
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        pending.current.size ||
        current.current.hostInputPending ||
        !element?.contains(document.activeElement)
      )
        return;
      event.preventDefault();
      dismiss();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [args.enabled, args.fullscreen, collapsed, dismiss]);
  const trackInput = useCallback(
    (report?: (pending: boolean) => void) => {
      const id = Symbol();
      let finished = false;
      const update = (waiting: boolean) => {
        if (finished) return;
        if (waiting) {
          pending.current.add(id);
          conceal();
        } else pending.current.delete(id);
        setPendingCount(pending.current.size);
        report?.(waiting);
      };
      return {
        update,
        finish: () => {
          if (pending.current.has(id)) update(false);
          finished = true;
        },
      };
    },
    [conceal],
  );
  return {
    collapsed,
    dismiss,
    open,
    trackInput,
    pending: pendingCount > 0 || args.hostInputPending,
  };
}
