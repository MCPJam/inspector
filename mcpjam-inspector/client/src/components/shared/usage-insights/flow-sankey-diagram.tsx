import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { GripVertical } from "lucide-react";
import {
  SortableContext,
  arrayMove,
  useSortable,
  type SortingStrategy,
} from "@dnd-kit/sortable";
import {
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

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

/**
 * dnd-kit's default sensor treats the whole sortable as a handle. Question
 * labels, the plus, and the editor are buttons/inputs inside that handle, so a
 * click never reaches them. Skip those — drag still starts from the title
 * text and the empty header chrome.
 */
class HeaderPointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: "onPointerDown" as const,
      handler: ({ nativeEvent }: { nativeEvent: PointerEvent }) => {
        if (!nativeEvent.isPrimary || nativeEvent.button !== 0) return false;
        const target = nativeEvent.target;
        return !(
          target instanceof Element &&
          target.closest("button, input, textarea, [data-no-dnd]")
        );
      },
    },
  ];
}

/**
 * Headers sit on absolute column X, not in a flex row. The default horizontal
 * strategy still slides siblings into a phantom order during drag.
 */
const pinnedColumnStrategy: SortingStrategy = () => null;

const VIEW_WIDTH = 1160;
/** Reserved to the right of the last column for its labels. */
const LABEL_GUTTER = 260;
/** Band at the top of the SVG holding the column headers. */
const HEADER_HEIGHT = 26;
/** Room for a last-column title plus the add-column control (icon or editor). */
const HEADER_SLOT = 235;
const TRAILING_SLOT = 220;

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
  fillRemainingViewport = false,
  labelForNode,
  headerContent,
  headerTrailing,
  headerHeight = HEADER_HEIGHT,
  toolbar,
  onReorderStages,
  reorderDisabled = false,
  isSelectable,
  isLinkSelectable,
}: {
  headerContent?: Partial<Record<S, ReactNode>>;
  headerTrailing?: ReactNode;
  headerHeight?: number;
  /**
   * Chrome above the chart (Session flow title, view toggle). Renders outside
   * the scrolling pane so a wide or tall diagram cannot carry it away.
   */
  toolbar?: ReactNode;
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
  /**
   * Fill the leftover parent the way `fillHeight` fills a locked pane:
   * stretch the columns into that box and scroll them under sticky titles.
   * The page must not grow with the SVG — that is what orphaned the ribbons.
   */
  fillRemainingViewport?: boolean;
  /** Persist a dragged permutation of `stages`. Omit to keep headers fixed. */
  onReorderStages?: (stages: S[]) => void;
  /** Block drag while a column editor is open so the pointer stays on the form. */
  reorderDisabled?: boolean;
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
  // The canvas widens with the column count instead of squeezing columns into a
  // fixed width. The add-column control sits in the last header, not in a
  // reserved strip on the far right — that strip left a lone plus floating
  // past the last labels.
  const viewWidth = Math.max(VIEW_WIDTH, stages.length * 260);
  const [hovered, setHovered] = useState<string | null>(null);
  const [readout, setReadout] = useState<string | null>(null);
  const fillsPane = fillHeight || fillRemainingViewport;
  const pane = usePaneSize(fillsPane);
  const chartPaneRef = pane.ref;
  const chartPaneSize = pane.size;
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

  // Extra columns need a floor wider than the pane. Stretch and header %
  // must use that drawn width — using the pane's client width is what
  // letterboxed the SVG (`xMid` + meet) and slid the bars off the titles
  // until someone deleted a column and the floor fit again.
  const wideMinWidth = stages.length > 4 ? stages.length * 190 : undefined;
  const drawnWidth = Math.max(chartPaneSize.width, wideMinWidth ?? 0);

  const height = useMemo(() => {
    if (!fillsPane || drawnWidth <= 0 || chartPaneSize.height <= 0) {
      return contentHeight;
    }
    const available = Math.round(
      (chartPaneSize.height / drawnWidth) * viewWidth,
    );
    return Math.max(contentHeight, available);
  }, [fillsPane, drawnWidth, chartPaneSize.height, contentHeight, viewWidth]);

  const layout = useMemo(() => {
    if (sankey.nodes.length === 0) return null;
    const usable = viewWidth - LABEL_GUTTER;
    const lastIndex = Math.max(1, stages.length - 1);
    const columnX = stages.map(
      (_, index) => 40 + (index * (usable - SANKEY_NODE_WIDTH)) / lastIndex,
    );
    return layoutSankey(sankey, viewWidth, height, columnX, stages);
  }, [sankey, height, stages, viewWidth]);

  const chartNeedsScroll =
    fillsPane &&
    chartPaneSize.height > 0 &&
    drawnWidth > 0 &&
    height > (chartPaneSize.height / drawnWidth) * viewWidth + 1;

  if (!layout) return null;

  const paneScrolls = fillsPane || chartNeedsScroll || stages.length > 4;

  return (
    <>
    {toolbar ? (
      <div
        data-testid="sankey-flow-header"
        className="shrink-0 bg-background"
      >
        {toolbar}
      </div>
    ) : null}
    <div
      ref={chartPaneRef}
      data-testid="sankey-chart-pane"
      className={cn(
        "relative z-0 w-full min-w-0",
        fillsPane && "min-h-0 flex-1",
        paneScrolls ? "overflow-auto" : "overflow-hidden",
      )}
    >
      <div
        className={cn(
          "shrink-0 bg-background",
          fillsPane && "sticky top-0 z-10",
        )}
        style={wideMinWidth ? { minWidth: wideMinWidth } : undefined}
      >
        <SankeyColumnHeaders
          stages={stages}
          stageTitles={stageTitles}
          stageColors={stageColors}
          headerContent={headerContent}
          headerTrailing={headerTrailing}
          headerHeight={headerHeight}
          columnX={layout.columnX}
          viewWidth={viewWidth}
          minWidth={wideMinWidth}
          onReorderStages={onReorderStages}
          reorderDisabled={reorderDisabled}
        />
      </div>
        <svg
          viewBox={`0 0 ${viewWidth} ${height}`}
          style={wideMinWidth ? { minWidth: wideMinWidth } : undefined}
          role="group"
          aria-label={ariaLabel}
          preserveAspectRatio="xMinYMin meet"
          className={cn(
            "block w-full",
            fillsPane && !chartNeedsScroll ? "h-full" : "mt-1 h-auto",
          )}
        >

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

          <g>
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
                  onActivate={() => onSelectLink?.(link.source, link.target)}
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

          <g>
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

function SankeyColumnHeaders<S extends string>({
  stages,
  stageTitles,
  stageColors,
  headerContent,
  headerTrailing,
  headerHeight,
  columnX,
  viewWidth,
  minWidth,
  onReorderStages,
  reorderDisabled,
}: {
  stages: readonly S[];
  stageTitles: Record<S, string>;
  stageColors: Record<S, FlowStageColor>;
  headerContent?: Partial<Record<S, ReactNode>>;
  headerTrailing?: ReactNode;
  headerHeight: number;
  columnX: number[];
  viewWidth: number;
  minWidth?: number;
  onReorderStages?: (stages: S[]) => void;
  reorderDisabled?: boolean;
}) {
  const [activeId, setActiveId] = useState<S | null>(null);
  const [a11yRoot, setA11yRoot] = useState<HTMLDivElement | null>(null);
  const sensors = useSensors(
    useSensor(HeaderPointerSensor, { activationConstraint: { distance: 8 } }),
  );
  const reorderable = onReorderStages != null && !reorderDisabled;

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    if (!onReorderStages || !over || active.id === over.id) return;
    const oldIndex = stages.indexOf(active.id as S);
    const newIndex = stages.indexOf(over.id as S);
    if (oldIndex < 0 || newIndex < 0) return;
    onReorderStages(arrayMove([...stages], oldIndex, newIndex));
  };

  const row = (
    <div
      className="relative w-full"
      data-testid="sankey-column-headers"
      data-reorderable={reorderable ? "true" : undefined}
      style={{ minWidth, height: headerHeight }}
    >
      {stages.map((stage, index) => {
        const trailing =
          index === stages.length - 1 ? headerTrailing : undefined;
        const slot = HEADER_SLOT + (trailing ? TRAILING_SLOT : 0);
        const style: CSSProperties = {
          left: `${(columnX[index] / viewWidth) * 100}%`,
          width: `${(slot / viewWidth) * 100}%`,
          height: headerHeight,
          color: stageColors[stage]?.head,
        };
        const inner = (
          <>
            {onReorderStages ? (
              <GripVertical
                aria-hidden
                className="size-3 shrink-0 opacity-40"
              />
            ) : null}
            {headerContent?.[stage] ?? (
              <span className="text-[10.5px] font-semibold uppercase tracking-[0.13em]">
                {stageTitles[stage]}
              </span>
            )}
            {trailing}
          </>
        );
        const className = cn(
          "absolute top-0 flex gap-1.5 select-none",
          headerHeight > HEADER_HEIGHT ? "items-start" : "items-center",
        );
        if (!onReorderStages) {
          return (
            <div
              key={stage}
              data-column-x={columnX[index]}
              data-column-id={stage}
              className={className}
              style={style}
            >
              {inner}
            </div>
          );
        }
        return (
          <SortableColumnHeader
            key={stage}
            id={stage}
            disabled={!reorderable}
            columnX={columnX[index]}
            title={
              reorderable
                ? `Drag to reorder the ${stageTitles[stage]} column`
                : undefined
            }
            className={className}
            style={style}
          >
            {inner}
          </SortableColumnHeader>
        );
      })}
    </div>
  );

  if (!onReorderStages) return row;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      accessibility={{
        container: a11yRoot ?? undefined,
        announcements: {
          onDragStart({ active }) {
            return `Picked up the ${stageTitles[active.id as S] ?? active.id} column`;
          },
          // Silent on purpose: the columns hold position while a header is
          // dragged, so there is no intermediate move to announce. dnd-kit
          // types this as `string | undefined`, not `void`.
          onDragOver(): string | undefined {
            return undefined;
          },
          onDragEnd({ active, over }) {
            const name = stageTitles[active.id as S] ?? String(active.id);
            if (!over || active.id === over.id) {
              return `Released the ${name} column`;
            }
            return `Moved the ${name} column`;
          },
          onDragCancel({ active }) {
            return `Cancelled moving the ${stageTitles[active.id as S] ?? active.id} column`;
          },
        },
      }}
      onDragStart={({ active }) => setActiveId(active.id as S)}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <div ref={setA11yRoot} className="sr-only" data-testid="sankey-dnd-a11y" />
      <SortableContext items={[...stages]} strategy={pinnedColumnStrategy}>
        {row}
      </SortableContext>
      <DragOverlay dropAnimation={null}>
        {activeId ? (
          <div
            className="flex cursor-grabbing items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.13em]"
            style={{ color: stageColors[activeId]?.head }}
          >
            <GripVertical aria-hidden className="size-3 shrink-0 opacity-40" />
            {stageTitles[activeId]}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function SortableColumnHeader({
  id,
  disabled,
  columnX,
  title,
  className,
  style,
  children,
}: {
  id: string;
  disabled: boolean;
  columnX: number;
  title?: string;
  className?: string;
  style: CSSProperties;
  children: ReactNode;
}) {
  const { listeners, setNodeRef, isDragging } = useSortable({
    id,
    disabled,
    // Absolute columns must not animate into a flex-row ghost order.
    animateLayoutChanges: () => false,
  });
  // Pointer-only: Space/Enter on a nested question-label button must still
  // open the editor, not start a sortable keyboard drag.
  const dragListeners =
    listeners == null
      ? {}
      : (({ onKeyDown: _ignored, ...pointerListeners }) => pointerListeners)(
          listeners,
        );

  return (
    <div
      ref={setNodeRef}
      data-column-x={columnX}
      data-column-id={id}
      data-dragging={isDragging ? "true" : undefined}
      title={title}
      className={cn(
        className,
        !disabled && "cursor-grab",
        isDragging && "z-30 cursor-grabbing opacity-40",
      )}
      style={style}
      {...dragListeners}
    >
      {children}
    </div>
  );
}
