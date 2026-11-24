import { useLayoutEffect, useState } from "react";

/** Where the trace timeline puts its span detail pane. */
export type TraceDetailPlacement = "below" | "auto";

/** Width at which "auto" moves the detail beside the waterfall. */
const BESIDE_MIN_WIDTH = 1024;

/**
 * "auto" puts the detail beside the waterfall once both get a readable width.
 * The container is tracked through a callback ref because the timeline can
 * mount it later, when recorded spans arrive.
 */
export function useTraceDetailDirection(placement: TraceDetailPlacement) {
  const [element, containerRef] = useState<HTMLDivElement | null>(null);
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    if (placement !== "auto" || !element) return;
    const measure = () =>
      setWide(element.getBoundingClientRect().width >= BESIDE_MIN_WIDTH);
    measure();
    // Without ResizeObserver (old browsers, jsdom) the first measure stands.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [placement, element]);
  const direction: "horizontal" | "vertical" =
    placement === "auto" && wide ? "horizontal" : "vertical";
  return { containerRef, direction };
}
