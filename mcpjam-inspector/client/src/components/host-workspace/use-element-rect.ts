import { useEffect, useState } from "react";

export interface ViewportRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * An element's viewport rectangle, kept current through resizes, window
 * resizes and scrolling. `null` while there is no element or it has no size.
 */
export function useElementViewportRect(
  element: HTMLElement | null,
): ViewportRect | null {
  const [rect, setRect] = useState<ViewportRect | null>(null);
  useEffect(() => {
    if (!element) {
      setRect(null);
      return;
    }
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const box = element.getBoundingClientRect();
        const next =
          box.width > 0 && box.height > 0
            ? {
                top: Math.round(box.top),
                left: Math.round(box.left),
                width: Math.round(box.width),
                height: Math.round(box.height),
              }
            : null;
        setRect((old) =>
          old &&
          next &&
          old.top === next.top &&
          old.left === next.left &&
          old.width === next.width &&
          old.height === next.height
            ? old
            : next,
        );
      });
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [element]);
  return rect;
}
