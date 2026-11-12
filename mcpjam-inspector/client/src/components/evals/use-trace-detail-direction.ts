import { useLayoutEffect, useRef, useState } from "react";

/** Where the trace timeline puts its span detail pane. */
export type TraceDetailPlacement = "below" | "auto";

/** Width at which "auto" moves the detail beside the waterfall. */
const BESIDE_MIN_WIDTH = 1024;

/** "auto" puts the detail beside the waterfall once both get a readable width. */
export function useTraceDetailDirection(placement: TraceDetailPlacement) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (placement !== "auto" || !element) return;
    const measure = () =>
      setWide(element.getBoundingClientRect().width >= BESIDE_MIN_WIDTH);
    measure();
    // Without ResizeObserver (old browsers, jsdom) the first measure stands.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [placement]);
  const direction: "horizontal" | "vertical" =
    placement === "auto" && wide ? "horizontal" : "vertical";
  return { containerRef, direction };
}
