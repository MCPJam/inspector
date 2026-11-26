import { useCallback, useEffect, useState, type RefObject } from "react";
import type { Node } from "@xyflow/react";

/**
 * How far content laid out below a card must move once the card's rendered
 * height is known. A builder positions that content from a height estimate;
 * the canvas measures the card and moves the content by the difference.
 * 0 until the card is measured, or when there is no estimate to correct.
 */
export function measuredShiftDelta(
  measuredHeight: number,
  estimatedHeight: number | null,
): number {
  if (measuredHeight <= 0 || estimatedHeight === null) return 0;
  return measuredHeight - estimatedHeight;
}

/**
 * Move the nodes `shouldShift` selects down by `dy`. Returns the same array
 * when `dy` is 0 and the same node for every node that does not move.
 */
export function shiftNodesY<N extends Node>(
  nodes: N[],
  dy: number,
  shouldShift: (node: N) => boolean,
): N[] {
  if (dy === 0) return nodes;
  return nodes.map((node) =>
    shouldShift(node)
      ? { ...node, position: { x: node.position.x, y: node.position.y + dy } }
      : node,
  );
}

/**
 * The shift for one content-sized card: `reportHeight` takes the card's
 * measured height (see `useReportedHeight`), and `dy` is how far the content
 * below it must move. Heights within half a pixel of the last one are ignored
 * so subpixel layout noise does not re-render the canvas.
 */
export function useMeasuredShift(estimatedHeight: number | null): {
  dy: number;
  reportHeight: (height: number) => void;
} {
  const [measuredHeight, setMeasuredHeight] = useState(0);
  const reportHeight = useCallback((height: number) => {
    setMeasuredHeight((prev) =>
      Math.abs(prev - height) < 0.5 ? prev : height,
    );
  }, []);
  return {
    dy: measuredShiftDelta(measuredHeight, estimatedHeight),
    reportHeight,
  };
}

/**
 * Report an element's rendered height whenever it changes. ResizeObserver
 * reads the layout box, so transform animations on the element do not
 * pollute the value.
 */
export function useReportedHeight(
  ref: RefObject<HTMLElement | null>,
  reportHeight: ((height: number) => void) | undefined,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || !reportHeight) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const box = entry.borderBoxSize?.[0];
      const h = box ? box.blockSize : entry.contentRect.height;
      if (h > 0) reportHeight(h);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, reportHeight]);
}
