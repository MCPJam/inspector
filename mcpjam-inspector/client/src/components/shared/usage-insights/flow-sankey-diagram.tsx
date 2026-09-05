import { useCallback, useId, useMemo, useRef, useState } from "react";

import type {
  InsightsSankey,
  InsightsSankeyNode,
} from "@/hooks/useUsageInsights";
import {
  SANKEY_NODE_WIDTH,
  layoutSankey,
  stageValueLabel,
  type SankeyLayoutNode,
} from "@/components/shared/usage-insights/insights-sankey";
import { cn } from "@/lib/utils";

export type FlowStageColor = { node: string; head: string };

const VIEW_WIDTH = 1160;
/** Reserved to the right of the last column for its labels. */
const LABEL_GUTTER = 260;
/** Band at the top of the SVG holding the column headers. */
const HEADER_HEIGHT = 26;

function contentSankeyHeight(nodeCountWidestColumn: number): number {
  return Math.max(320, nodeCountWidestColumn * 42 + 40);
}

/**
 * Measure a flex child that should absorb leftover viewport height. Returns
 * zero until the first layout so callers can fall back to content height.
 *
 * A callback ref, not useRef + effect: the pane div only mounts once the
 * breakdown arrives (the loading/empty branches skip it), which is after a
 * mount effect keyed on `enabled` has already run against a null ref — it
 * would observe nothing and never re-attach, leaving the diagram at its
 * content floor inside a full-height pane.
 */
function usePaneSize(enabled: boolean) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const detachRef = useRef<(() => void) | null>(null);

  const ref = useCallback(
    (element: HTMLDivElement | null) => {
      detachRef.current?.();
      detachRef.current = null;
      if (!enabled || !element) return;

      const update = () => {
        const width = Math.round(element.clientWidth);
        const height = Math.round(element.clientHeight);
        setSize((current) =>
          current.width === width && current.height === height
            ? current
            : { width, height },
        );
      };

      update();
      if (typeof ResizeObserver === "undefined") {
        window.addEventListener("resize", update);
        detachRef.current = () => window.removeEventListener("resize", update);
        return;
      }
      const observer = new ResizeObserver(update);
      observer.observe(element);
      detachRef.current = () => observer.disconnect();
    },
    [enabled],
  );

  return { ref, size };
}

export function FlowSankeyDiagram<S extends string>({
  sankey,
  stages,
  stageTitles,
  stageColors,
  unitNoun,
  discordantHighlight = false,
  selectedKeys,
  onSelectNode,
  onSelectLink,
  ariaLabel,
  fillHeight = false,
  labelForNode,
  isSelectable,
  isLinkSelectable,
}: {
  sankey: InsightsSankey<S>;
  stages: readonly S[];
  stageTitles: Record<S, string>;
  stageColors: Record<S, FlowStageColor>;
  unitNoun: string;
  discordantHighlight?: boolean;
  selectedKeys?: ReadonlySet<string>;
  onSelectNode?: (node: InsightsSankeyNode<S>) => void;
  onSelectLink?: (
    source: InsightsSankeyNode<S>,
    target: InsightsSankeyNode<S>,
  ) => void;
  ariaLabel: string;
  /**
   * Stretch into the parent height and re-lay the diagram to match the
   * available pane. Default keeps content-sized height.
   */
  fillHeight?: boolean;
  /** Defaults to {@link stageValueLabel} ("Not analyzed" for unlabeled). */
  labelForNode?: (node: InsightsSankeyNode<S>) => string;
  /**
   * Whether a click on this node would select anything. Defaults to
   * `node.clickable`; a caller whose selection model refuses some clickable
   * nodes (the unlabeled / other sentinels) passes its own answer so those
   * are not announced as buttons that do nothing.
   */
  isSelectable?: (node: InsightsSankeyNode<S>) => boolean;
  /** Same for a link. Defaults to both endpoints being selectable. */
  isLinkSelectable?: (
    source: InsightsSankeyNode<S>,
    target: InsightsSankeyNode<S>,
  ) => boolean;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [readout, setReadout] = useState<string | null>(null);
  const { ref: chartPaneRef, size: chartPaneSize } = usePaneSize(fillHeight);
  // Gradient ids are per diagram instance and per link INDEX. Two diagrams
  // on one page must not share `<defs>` ids, and two links whose node ids
  // differ only in a character the sanitizer folds must not share one
  // either — the index is unique where a sanitized name is not.
  const gradientPrefix = `flow-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const gradientIdFor = (index: number) => `${gradientPrefix}-${index}`;
  // A node is dimmed only when there is a selection model to be refused by.
  // A diagram with no callbacks is a picture, and every node in it reads at
  // full weight.
  const hasSelectionModel = onSelectNode !== undefined;
  const valueLabel = labelForNode ?? stageValueLabel;
  const nodeSelectable = (node: InsightsSankeyNode<S>): boolean =>
    isSelectable ? isSelectable(node) : node.clickable;
  const linkSelectable = (
    source: InsightsSankeyNode<S>,
    target: InsightsSankeyNode<S>,
  ): boolean =>
    isLinkSelectable
      ? isLinkSelectable(source, target)
      : nodeSelectable(source) && nodeSelectable(target);

  const contentHeight = useMemo(() => {
    const widest = Math.max(
      1,
      ...stages.map(
        (stage) => sankey.nodes.filter((n) => n.stage === stage).length,
      ),
    );
    return contentSankeyHeight(widest);
  }, [sankey, stages]);

  const height = useMemo(() => {
    if (
      !fillHeight ||
      chartPaneSize.width <= 0 ||
      chartPaneSize.height <= 0
    ) {
      return contentHeight;
    }
    const available = Math.round(
      (chartPaneSize.height / chartPaneSize.width) * VIEW_WIDTH -
        HEADER_HEIGHT,
    );
    return Math.max(contentHeight, available);
  }, [fillHeight, chartPaneSize.height, chartPaneSize.width, contentHeight]);

  const layout = useMemo(() => {
    if (sankey.nodes.length === 0) return null;
    const usable = VIEW_WIDTH - LABEL_GUTTER;
    const lastIndex = Math.max(1, stages.length - 1);
    const columnX = stages.map(
      (_, index) => 40 + (index * (usable - SANKEY_NODE_WIDTH)) / lastIndex,
    );
    return layoutSankey(sankey, VIEW_WIDTH, height, columnX, stages);
  }, [sankey, height, stages]);

  const chartNeedsScroll =
    fillHeight &&
    chartPaneSize.height > 0 &&
    height + HEADER_HEIGHT >
      (chartPaneSize.width > 0
        ? (chartPaneSize.height / chartPaneSize.width) * VIEW_WIDTH
        : 0) +
        1;

  if (!layout) return null;

  return (
    <>
      <div
        ref={chartPaneRef}
        className={cn(
          "w-full min-w-0",
          fillHeight && "min-h-0 flex-1",
          chartNeedsScroll ? "overflow-auto" : "overflow-hidden",
        )}
      >
        <svg
          viewBox={`0 0 ${VIEW_WIDTH} ${height + HEADER_HEIGHT}`}
          role="group"
          aria-label={ariaLabel}
          preserveAspectRatio="xMidYMin meet"
          className={cn(
            "block w-full",
            fillHeight && !chartNeedsScroll ? "h-full" : "mt-1 h-auto",
          )}
        >
          <g>
            {stages.map((stage, index) => (
              <text
                key={stage}
                x={layout.columnX[index]}
                y={14}
                fill={stageColors[stage].head}
                className="text-[10.5px] font-semibold uppercase [letter-spacing:0.13em]"
              >
                {stageTitles[stage]}
              </text>
            ))}
          </g>

          <defs>
            {layout.links.map((link, index) => (
              <linearGradient
                key={gradientIdFor(index)}
                id={gradientIdFor(index)}
                x1="0"
                x2="1"
                y1="0"
                y2="0"
              >
                <stop
                  offset="0%"
                  stopColor={
                    discordantHighlight && link.discordant
                      ? "var(--warning)"
                      : stageColors[link.source.stage].node
                  }
                />
                <stop
                  offset="100%"
                  stopColor={
                    discordantHighlight && link.discordant
                      ? "var(--warning)"
                      : stageColors[link.target.stage].node
                  }
                />
              </linearGradient>
            ))}
          </defs>

          <g transform={`translate(0, ${HEADER_HEIGHT})`}>
            {layout.links.map((link, index) => {
              const id = `${link.source.id}→${link.target.id}`;
              const selectable =
                !!onSelectLink && linkSelectable(link.source, link.target);
              const flagged = discordantHighlight && link.discordant;
              const base = flagged ? 0.44 : 0.26;
              const label = `${valueLabel(link.source)} to ${valueLabel(
                link.target,
              )}, ${link.count} ${unitNoun}${
                flagged ? ", outcome and sentiment disagree" : ""
              }`;
              const describe = () => {
                setHovered(id);
                setReadout(
                  `${valueLabel(link.source)} → ${valueLabel(
                    link.target,
                  )} · ${link.count.toLocaleString()} ${unitNoun}${
                    flagged ? " · outcome and sentiment disagree" : ""
                  }`,
                );
              };
              return (
                <FlowTarget
                  key={id}
                  label={label}
                  selectable={selectable}
                  onEnter={describe}
                  onLeave={() => {
                    setHovered(null);
                    setReadout(null);
                  }}
                  onActivate={() =>
                    onSelectLink?.(link.source, link.target)
                  }
                  focusClass="[&:focus-visible>path]:stroke-foreground [&:focus-visible>path]:stroke-2"
                >
                  <path
                    d={link.path}
                    fill={`url(#${gradientIdFor(index)})`}
                    fillOpacity={
                      hovered === id ? Math.min(base + 0.32, 0.82) : base
                    }
                  />
                </FlowTarget>
              );
            })}
          </g>

          <g transform={`translate(0, ${HEADER_HEIGHT})`}>
            {layout.nodes.map((node) => {
              const selectable = !!onSelectNode && nodeSelectable(node);
              const emphasized =
                selectedKeys?.has(`${node.stage}:${node.key}`) ?? false;
              return (
                <FlowTarget
                  key={node.id}
                  label={`${valueLabel(node)}, ${node.count} ${unitNoun}, ${
                    node.share
                  } percent of ${node.stage}${
                    selectable ? "" : ", not selectable"
                  }`}
                  selectable={selectable}
                  onEnter={() =>
                    setReadout(
                      `${valueLabel(node)} · ${node.count.toLocaleString()} ${unitNoun} · ${
                        node.share
                      }% of ${node.stage}`,
                    )
                  }
                  onLeave={() => setReadout(null)}
                  onActivate={() => onSelectNode?.(node)}
                  focusClass="[&:focus-visible>rect]:stroke-foreground [&:focus-visible>rect]:stroke-2"
                >
                  <FlowNodeShape
                    node={node}
                    color={stageColors[node.stage]}
                    emphasized={emphasized}
                    dimmed={hasSelectionModel && !selectable}
                    label={valueLabel(node)}
                  />
                </FlowTarget>
              );
            })}
          </g>
        </svg>
      </div>

      <div aria-live="polite" className="sr-only">
        {readout}
      </div>
    </>
  );
}

function FlowTarget({
  label,
  selectable,
  onEnter,
  onLeave,
  onActivate,
  focusClass,
  children,
}: {
  label: string;
  selectable: boolean;
  onEnter: () => void;
  onLeave: () => void;
  onActivate: () => void;
  focusClass: string;
  children: React.ReactNode;
}) {
  return (
    <g
      role={selectable ? "button" : "img"}
      tabIndex={selectable ? 0 : -1}
      aria-label={label}
      className={`focus:outline-none ${focusClass}`}
      style={{ cursor: selectable ? "pointer" : "default" }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
      onClick={() => selectable && onActivate()}
      onKeyDown={(event) => {
        if (!selectable) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onActivate();
        }
      }}
    >
      {children}
    </g>
  );
}

function FlowNodeShape<S extends string>({
  node,
  color,
  emphasized,
  dimmed,
  label,
}: {
  node: SankeyLayoutNode<S>;
  color: FlowStageColor;
  emphasized: boolean;
  /** The selection model refused this node; a diagram without one never dims. */
  dimmed: boolean;
  label: string;
}) {
  const labelX = node.x + SANKEY_NODE_WIDTH + 10;
  const anchor = "start";

  return (
    <>
      <rect
        x={node.x}
        y={node.y}
        width={SANKEY_NODE_WIDTH}
        height={node.height}
        rx={3}
        fill={emphasized ? color.head : color.node}
        fillOpacity={dimmed ? 0.45 : 1}
      />
      <text
        x={labelX}
        y={node.y + 12}
        textAnchor={anchor}
        className="pointer-events-none fill-foreground text-[12px] font-medium"
      >
        {label}
      </text>
      {node.height >= 26 ? (
        <text
          x={labelX}
          y={node.y + 27}
          textAnchor={anchor}
          className="pointer-events-none fill-muted-foreground text-[10.5px] tabular-nums"
        >
          {node.count.toLocaleString()} · {node.share}%
        </text>
      ) : null}
    </>
  );
}
