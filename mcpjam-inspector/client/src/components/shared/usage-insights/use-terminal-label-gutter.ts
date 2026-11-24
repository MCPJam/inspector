import { useLayoutEffect, useRef, useState } from "react";
import type {
  InsightsSankey,
  InsightsSankeyNode,
} from "@/hooks/useUsageInsights";

const LABEL_GUTTER = 260;
/** Keep room for the terminal column title and its controls on desktop. */
const MIN_CONTENT_LABEL_GUTTER = 195;

export function useTerminalLabelGutter<S extends string>(
  enabled: boolean,
  stage: S | undefined,
  sankey: InsightsSankey<S>,
  labelForNode: (node: InsightsSankeyNode<S>) => string,
  viewWidth: number,
  labelPadding: number,
) {
  const chartRef = useRef<SVGSVGElement>(null);
  const [labelWidth, setLabelWidth] = useState(0);

  useLayoutEffect(() => {
    const chart = chartRef.current;
    if (!enabled || !chart) return;
    const labels = chart.querySelectorAll<SVGTextContentElement>(
      "[data-terminal-label]",
    );
    // Text lengths are in SVG units and do not depend on the chart pane's size.
    setLabelWidth(
      Math.max(
        0,
        ...Array.from(labels, (label) => label.getComputedTextLength?.() ?? 0),
      ),
    );
  }, [enabled, stage, sankey, labelForNode]);

  const labelGutter =
    enabled && labelWidth > 0
      ? Math.min(
          viewWidth / 3, // Leave most of the diagram for the flow itself.
          Math.max(MIN_CONTENT_LABEL_GUTTER, labelWidth + labelPadding),
        )
      : LABEL_GUTTER;
  return { chartRef, labelGutter };
}
