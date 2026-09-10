import { useCallback, useEffect, useRef } from "react";
import {
  normalizeViewportSize,
  type ViewportSize,
} from "@/shared/browser-viewport";

/** One pane-size policy for inspection and the browser shell. */
export function useViewportReporter(
  report: (size: ViewportSize) => Promise<unknown> | void,
  generation: unknown,
) {
  const reportRef = useRef(report);
  reportRef.current = report;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sent = useRef<ViewportSize | undefined>(undefined);
  const epoch = useRef(0);
  useEffect(() => {
    sent.current = undefined;
    epoch.current++;
    return () => {
      epoch.current++;
      clearTimeout(timer.current);
    };
  }, [generation]);
  return useCallback((size: ViewportSize) => {
    const next = normalizeViewportSize(size);
    clearTimeout(timer.current);
    if (
      sent.current?.width === next.width &&
      sent.current?.height === next.height
    )
      return;
    const mine = epoch.current;
    timer.current = setTimeout(() => {
      if (mine !== epoch.current) return;
      sent.current = next;
      Promise.resolve()
        .then(() => {
          if (mine === epoch.current) return reportRef.current(next);
        })
        .catch(() => {
          if (mine === epoch.current && sent.current === next)
            sent.current = undefined;
        });
    }, 80);
  }, []);
}
