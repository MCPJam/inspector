import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertTriangle, Info, RefreshCw, Target } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import {
  SIGNALS_VERSION_WITH_THEMES,
  type SankeyStage,
  type UsageBreakdown,
} from "@/hooks/useUsageInsights";
import { type InsightsSelection } from "@/hooks/scenario-usage-filters";
import { ClusterTuningControl } from "@/components/shared/usage-insights/ClusterTuningControl";
import type { ClusterTuning } from "@/lib/cluster-tuning";
import {
  SANKEY_NODE_WIDTH,
  STAGE_ORDER,
  STAGE_TITLES,
  layoutSankey,
  selectionForLink,
  selectionForNode,
  stageValueLabel,
  type SankeyLayoutLink,
  type SankeyLayoutNode,
} from "@/components/shared/usage-insights/insights-sankey";
import { cn } from "@/lib/utils";

interface SessionFlowSankeyProps {
  breakdown: UsageBreakdown | null | undefined;
  /** Currently open selection, so its endpoints can read as selected. */
  selection: InsightsSelection | null;
  onSelectNode: (selection: InsightsSelection) => void;
  onSelectLink: (selection: InsightsSelection) => void;
  onRebuild: () => void;
  rebuildBusy: boolean;
  /**
   * Rebuild with explicit clustering settings. Omitted callers get no tuning
   * control at all — the header is shared with surfaces that only ever want
   * the plain rebuild affordance.
   */
  onApplyTuning?: (
    tuning: ClusterTuning,
    opts?: { force?: boolean },
  ) => void;
  /** False for scopes with no topic map, where link distance means nothing. */
  showLinkThreshold?: boolean;
  /**
   * Per-stage header overrides. Defaults come from `STAGE_TITLES`; callers
   * can rename a column without forking the chart.
   */
  stageTitles?: Partial<Record<SankeyStage, string>>;
  /**
   * Extra controls rendered immediately before the tuning (Balanced) control
   * in the header row — e.g. a Session flow / Clusters toggle on swarms.
   */
  headerActions?: ReactNode;
  /**
   * Stretch into the parent height and re-lay the diagram to match the
   * available pane (run-detail Insights). Default keeps content-sized height
   * for scrollable surfaces like the scenario usage panel.
   */
  fillHeight?: boolean;
}

/**
 * Per-axis colour. The four columns are independent clusterings, and giving
 * each its own hue is what lets a ribbon read as "this theme flows into that
 * one" rather than as one undifferentiated mass.
 */
const STAGE_COLOR: Record<SankeyStage, { node: string; head: string }> = {
  goal: { node: "#7fb3a0", head: "#2f8b76" },
  behavior: { node: "#8fb0d4", head: "#3d6fa6" },
  outcome: { node: "#e08356", head: "#c2552c" },
  sentiment: { node: "#bda2d8", head: "#7a5da3" },
};

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

function RebuildButton({
  onRebuild,
  busy,
  label,
}: {
  onRebuild: () => void;
  busy: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onRebuild()}
      disabled={busy}
      className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[11px] font-medium hover:bg-muted/50 disabled:opacity-60"
    >
      <RefreshCw className={`h-3 w-3 ${busy ? "animate-spin" : ""}`} />
      {busy ? "Rebuilding…" : label}
    </button>
  );
}

/**
 * Session flow: one emergent theme per axis, four axes, ribbons for the
 * sessions shared between adjacent ones.
 *
 * Every label here is a cluster name the analysis produced — there is no fixed
 * vocabulary to render, which is why the behavior column can say "Guessed an id
 * after truncation" rather than picking from a list written in advance.
 */
export function SessionFlowSankey({
  breakdown,
  selection,
  onSelectNode,
  onSelectLink,
  onRebuild,
  rebuildBusy,
  onApplyTuning,
  showLinkThreshold,
  stageTitles,
  headerActions,
  fillHeight = false,
}: SessionFlowSankeyProps) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [readout, setReadout] = useState<string | null>(null);
  const { ref: chartPaneRef, size: chartPaneSize } = usePaneSize(fillHeight);

  const sankey = breakdown?.sankey;
  const scan = breakdown?.scan;
  const signalsVersion = breakdown?.latestRun?.signalsVersion ?? null;

  const contentHeight = useMemo(() => {
    const widest = Math.max(
      1,
      ...STAGE_ORDER.map(
        (stage) => sankey?.nodes.filter((n) => n.stage === stage).length ?? 0,
      ),
    );
    return contentSankeyHeight(widest);
  }, [sankey]);

  // When filling the viewport, map the chart pane's CSS box into viewBox
  // units at VIEW_WIDTH so `meet` can occupy the full pane without
  // letterboxing. Never shrink below the content floor — overflow instead.
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
    if (!sankey || sankey.nodes.length === 0) return null;
    const usable = VIEW_WIDTH - LABEL_GUTTER;
    const columnX = STAGE_ORDER.map(
      (_, index) => 40 + (index * (usable - SANKEY_NODE_WIDTH)) / 3,
    );
    return layoutSankey(sankey, VIEW_WIDTH, height, columnX);
  }, [sankey, height]);

  const latestRun = breakdown?.latestRun ?? null;
  const chartNeedsScroll =
    fillHeight &&
    chartPaneSize.height > 0 &&
    height + HEADER_HEIGHT >
      (chartPaneSize.width > 0
        ? (chartPaneSize.height / chartPaneSize.width) * VIEW_WIDTH
        : 0) +
        1;

  /**
   * The tuning control, rendered in EVERY state including the two that return
   * early below.
   *
   * A swarm that has never clustered is exactly when someone wants to choose
   * how it should cluster, so gating the settings behind "there is already a
   * flow to look at" hides them precisely when they are most useful. It seeds
   * from the defaults when there is no run to read.
   */
  const tuningControl = onApplyTuning ? (
    <ClusterTuningControl
      value={latestRun?.tuning}
      onApply={onApplyTuning}
      busy={rebuildBusy}
      showLinkThreshold={showLinkThreshold}
      sessionCount={latestRun?.sessionCount}
    />
  ) : null;

  if (!breakdown) {
    return (
      <div
        className={cn(
          "flex items-center justify-between gap-3 text-xs text-muted-foreground",
          fillHeight ? "h-full px-0 py-6" : "px-5 py-10",
        )}
      >
        <span className="flex-1 text-center">Loading session flow…</span>
        <div className="flex items-center gap-2">
          {headerActions}
          {tuningControl}
        </div>
      </div>
    );
  }

  if (!sankey || sankey.nodes.length === 0 || !layout) {
    return (
      <div
        className={cn(
          "flex flex-col items-center gap-2 text-center",
          fillHeight ? "h-full justify-center px-0 py-6" : "px-5 py-10",
        )}
      >
        <Target className="h-6 w-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No session flow yet</p>
        <p className="max-w-md text-xs text-muted-foreground">
          {signalsVersion === null
            ? "The last rebuild ran before session signals existed. Rebuild clusters to extract and group goals, behaviors, outcomes, and sentiment."
            : "Rebuild clusters once there are enough sessions to cluster."}
        </p>
        <div className="flex items-center gap-2">
          {headerActions}
          <RebuildButton
            onRebuild={onRebuild}
            busy={rebuildBusy}
            label="Rebuild clusters"
          />
          {tuningControl}
        </div>
      </div>
    );
  }

  const needsThemeRebuild =
    signalsVersion !== null && signalsVersion < SIGNALS_VERSION_WITH_THEMES;
  const analysisInFlight =
    latestRun?.status === "queued" || latestRun?.status === "running";
  // What the first column is called on this surface, for banner copy —
  // "journeys" on the swarm panel, "goals" on the scenario one.
  const goalNoun = (stageTitles?.goal ?? STAGE_TITLES.goal).toLowerCase();
  const foldedTotal = STAGE_ORDER.reduce(
    (sum, stage) => sum + (sankey.foldedByStage?.[stage] ?? 0),
    0,
  );
  const selectedKeys = new Set(
    (selection?.themes ?? []).map(
      (theme) => `${theme.dimension}:${theme.clusterId}`,
    ),
  );

  return (
    <div
      className={cn(
        "flex flex-col gap-2",
        fillHeight
          ? "h-full min-h-0 overflow-hidden px-0 py-1"
          : "border-b px-5 py-4",
      )}
      data-testid="scenario-insights-sankey"
      data-fill-height={fillHeight ? "true" : undefined}
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">Session flow</h3>
          <Tooltip delayDuration={200}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="About the session flow"
                className="text-muted-foreground hover:text-foreground"
              >
                <Info className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs">
              Each column is clustered on its own, so a session&rsquo;s behavior
              theme says nothing about which outcome theme it lands in &mdash;
              that is what the ribbons show. Names are generated from the
              sessions in each group rather than chosen from a fixed list, so
              they change as the sessions do.
            </TooltipContent>
          </Tooltip>
        </div>
        {foldedTotal > 0 || headerActions || tuningControl ? (
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
            {foldedTotal > 0 ? (
              <span>
                {foldedTotal} smaller {foldedTotal === 1 ? "theme" : "themes"}{" "}
                folded
              </span>
            ) : null}
            {headerActions}
            {tuningControl}
          </div>
        ) : null}
      </div>

      {scan?.truncated ? (
        <div
          role="status"
          className="flex shrink-0 items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-[11px] text-warning-foreground"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Counts below cover the most recent {scan.matched.toLocaleString()}{" "}
            matching sessions, not the full history &mdash; the scan stops at{" "}
            {scan.maxSessions.toLocaleString()}. Older sessions are not
            included.
          </span>
        </div>
      ) : null}

      {/* One analysis banner at a time, most-live state first: a rebuild in
          flight beats advertising the button that starts one, and
          never-analyzed beats the old-signals nudge (which requires a run to
          exist at all). */}
      {analysisInFlight ? (
        <div
          role="status"
          className="flex shrink-0 items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground"
        >
          <RefreshCw className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
          <span>
            Analyzing sessions &mdash; grouping {goalNoun}s, behaviors,
            outcomes, and sentiment. This can take a few minutes.
          </span>
        </div>
      ) : latestRun === null ? (
        <div
          role="status"
          className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground"
        >
          <span>
            These sessions haven&rsquo;t been analyzed yet &mdash; the flow
            fills in once analysis groups {goalNoun}s, behaviors, outcomes, and
            sentiment.
          </span>
          <RebuildButton
            onRebuild={onRebuild}
            busy={rebuildBusy}
            label="Analyze sessions"
          />
        </div>
      ) : needsThemeRebuild ? (
        <div
          role="status"
          className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground"
        >
          <span>
            These sessions were analyzed before every column was clustered, so
            only the goal column has themes.
          </span>
          <RebuildButton
            onRebuild={onRebuild}
            busy={rebuildBusy}
            label="Rebuild for themes"
          />
        </div>
      ) : null}

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
          // Scale to the panel width; viewBox keeps column/header coordinates
          // aligned. No fixed max-width — the chart should always use the full
          // horizontal space, at any viewport.
          // `group`, not `img`: an image is a leaf, so `img` would hide every
          // node and ribbon button inside it from assistive tech — undoing the
          // point of making them focusable in the first place.
          role="group"
          aria-label="Session flow from goal through behavior and outcome to sentiment"
          preserveAspectRatio="xMidYMin meet"
          className={cn(
            "block w-full",
            fillHeight && !chartNeedsScroll
              ? "h-full"
              : "mt-1 h-auto",
          )}
        >
          {/*
            Headers live INSIDE the diagram, at the same x as the columns they
            name. As CSS they were a four-cell grid across the panel while the
            chart was a fixed-width box, so on a wide panel the last header sat
            hundreds of pixels from its own column. Sharing one coordinate space
            is the only way they cannot drift apart.
          */}
          <g>
            {STAGE_ORDER.map((stage, index) => (
              <text
                key={stage}
                x={layout.columnX[index]}
                y={14}
                fill={STAGE_COLOR[stage].head}
                className="text-[10.5px] font-semibold uppercase [letter-spacing:0.13em]"
              >
                {stageTitles?.[stage] ?? STAGE_TITLES[stage]}
              </text>
            ))}
          </g>

          <defs>
            {layout.links.map((link) => (
              <linearGradient
                key={gradientId(link)}
                id={gradientId(link)}
                x1="0"
                x2="1"
                y1="0"
                y2="0"
              >
                <stop
                  offset="0%"
                  stopColor={
                    link.discordant
                      ? "var(--warning)"
                      : STAGE_COLOR[link.source.stage].node
                  }
                />
                <stop
                  offset="100%"
                  stopColor={
                    link.discordant
                      ? "var(--warning)"
                      : STAGE_COLOR[link.target.stage].node
                  }
                />
              </linearGradient>
            ))}
          </defs>

          <g transform={`translate(0, ${HEADER_HEIGHT})`}>
            {layout.links.map((link) => {
              const id = `${link.source.id}→${link.target.id}`;
              const next = selectionForLink(link.source, link.target);
              const base = link.discordant ? 0.44 : 0.26;
              const label = `${stageValueLabel(
                link.source,
              )} to ${stageValueLabel(link.target)}, ${link.count} sessions${
                link.discordant ? ", outcome and sentiment disagree" : ""
              }`;
              const describe = () => {
                setHovered(id);
                setReadout(
                  `${stageValueLabel(link.source)} → ${stageValueLabel(
                    link.target,
                  )} · ${link.count.toLocaleString()} sessions${
                    link.discordant ? " · outcome and sentiment disagree" : ""
                  }`,
                );
              };
              return (
                <FlowTarget
                  key={id}
                  label={label}
                  selectable={!!next}
                  onEnter={describe}
                  onLeave={() => {
                    setHovered(null);
                    setReadout(null);
                  }}
                  onActivate={() => next && onSelectLink(next)}
                  focusClass="[&:focus-visible>path]:stroke-foreground [&:focus-visible>path]:stroke-2"
                >
                  <path
                    d={link.path}
                    fill={`url(#${gradientId(link)})`}
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
              const next = selectionForNode(node);
              const emphasized = selectedKeys.has(`${node.stage}:${node.key}`);
              return (
                <FlowTarget
                  key={node.id}
                  label={`${stageValueLabel(node)}, ${node.count} sessions, ${
                    node.share
                  } percent of ${node.stage}${next ? "" : ", not selectable"}`}
                  selectable={!!next}
                  onEnter={() =>
                    setReadout(
                      `${stageValueLabel(
                        node,
                      )} · ${node.count.toLocaleString()} sessions · ${
                        node.share
                      }% of ${node.stage}`,
                    )
                  }
                  onLeave={() => setReadout(null)}
                  onActivate={() => next && onSelectNode(next)}
                  focusClass="[&:focus-visible>rect]:stroke-foreground [&:focus-visible>rect]:stroke-2"
                >
                  <FlowNodeShape
                    node={node}
                    color={STAGE_COLOR[node.stage]}
                    emphasized={emphasized}
                    selectable={!!next}
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
    </div>
  );
}

function gradientId(link: SankeyLayoutLink): string {
  return `flow-${link.source.id}-${link.target.id}`.replace(
    /[^a-zA-Z0-9_-]/g,
    "_",
  );
}

/**
 * The interactive wrapper every node and ribbon shares.
 *
 * SVG shapes are not controls on their own: without an explicit role, tabindex
 * and key handling, the whole diagram is reachable by mouse only. Anything
 * clickable here is therefore focusable and answers Enter and Space; anything
 * that is not selectable is skipped by the tab order rather than being a focus
 * stop that does nothing.
 */
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

function FlowNodeShape({
  node,
  color,
  emphasized,
  selectable,
}: {
  node: SankeyLayoutNode;
  color: { node: string; head: string };
  emphasized: boolean;
  selectable: boolean;
}) {
  // Every column labels to the right of its bar, the last one included: the
  // gutter is reserved for it. Flipping the last column inward put its text on
  // top of the ribbons arriving at it, which read as a rendering fault.
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
        fillOpacity={selectable ? 1 : 0.45}
      />
      <text
        x={labelX}
        y={node.y + 12}
        textAnchor={anchor}
        className="pointer-events-none fill-foreground text-[12px] font-medium"
      >
        {stageValueLabel(node)}
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
