import { useMemo, useState } from "react";
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
import { type InsightsSelection } from "@/hooks/chatbox-usage-filters";
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
} from "@/components/chatboxes/insights-sankey";

interface ChatboxInsightsSankeyProps {
  breakdown: UsageBreakdown | null | undefined;
  /** Currently open selection, so its endpoints can read as selected. */
  selection: InsightsSelection | null;
  onSelectNode: (selection: InsightsSelection) => void;
  onSelectLink: (selection: InsightsSelection) => void;
  onRebuild: () => void;
  rebuildBusy: boolean;
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

const VIEW_WIDTH = 1040;
const LABEL_GUTTER = 200;

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
      onClick={onRebuild}
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
export function ChatboxInsightsSankey({
  breakdown,
  selection,
  onSelectNode,
  onSelectLink,
  onRebuild,
  rebuildBusy,
}: ChatboxInsightsSankeyProps) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [readout, setReadout] = useState<string | null>(null);

  const sankey = breakdown?.sankey;
  const scan = breakdown?.scan;
  const signalsVersion = breakdown?.latestRun?.signalsVersion ?? null;

  const height = useMemo(() => {
    const widest = Math.max(
      1,
      ...STAGE_ORDER.map(
        (stage) => sankey?.nodes.filter((n) => n.stage === stage).length ?? 0,
      ),
    );
    return Math.max(320, widest * 42 + 40);
  }, [sankey]);

  const layout = useMemo(() => {
    if (!sankey || sankey.nodes.length === 0) return null;
    const usable = VIEW_WIDTH - LABEL_GUTTER;
    const columnX = STAGE_ORDER.map(
      (_, index) => 40 + (index * (usable - SANKEY_NODE_WIDTH)) / 3,
    );
    return layoutSankey(sankey, VIEW_WIDTH, height, columnX);
  }, [sankey, height]);

  if (!breakdown) {
    return (
      <div className="flex items-center justify-center px-5 py-10 text-xs text-muted-foreground">
        Loading session flow…
      </div>
    );
  }

  if (!sankey || sankey.nodes.length === 0 || !layout) {
    return (
      <div className="flex flex-col items-center gap-2 px-5 py-10 text-center">
        <Target className="h-6 w-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No session flow yet</p>
        <p className="max-w-md text-xs text-muted-foreground">
          {signalsVersion === null
            ? "The last rebuild ran before session signals existed. Rebuild clusters to extract and group goals, behaviors, outcomes, and sentiment."
            : "Rebuild clusters once this chatbox has enough sessions to cluster."}
        </p>
        <RebuildButton
          onRebuild={onRebuild}
          busy={rebuildBusy}
          label="Rebuild clusters"
        />
      </div>
    );
  }

  const needsThemeRebuild =
    signalsVersion !== null && signalsVersion < SIGNALS_VERSION_WITH_THEMES;
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
    <div className="flex flex-col gap-2 border-b px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
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
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded-full bg-warning" />
            Outcome and sentiment disagree
          </span>
          {foldedTotal > 0 ? (
            <span>
              {foldedTotal} smaller {foldedTotal === 1 ? "theme" : "themes"}{" "}
              folded
            </span>
          ) : null}
        </div>
      </div>

      {scan?.truncated ? (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-[11px] text-warning-foreground"
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

      {needsThemeRebuild ? (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground"
        >
          <span>
            This chatbox was analyzed before every column was clustered, so only
            the goal column has themes.
          </span>
          <RebuildButton
            onRebuild={onRebuild}
            busy={rebuildBusy}
            label="Rebuild for themes"
          />
        </div>
      ) : null}

      <div className="grid grid-cols-4 gap-2 pt-1 text-[10.5px] font-semibold uppercase tracking-[0.13em]">
        {STAGE_ORDER.map((stage) => (
          <span
            key={stage}
            style={{ color: STAGE_COLOR[stage].head }}
            className={stage === "sentiment" ? "text-right" : undefined}
          >
            {STAGE_TITLES[stage]}
          </span>
        ))}
      </div>

      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${VIEW_WIDTH} ${height}`}
          width={VIEW_WIDTH}
          height={height}
          // `group`, not `img`: an image is a leaf, so `img` would hide every
          // node and ribbon button inside it from assistive tech — undoing the
          // point of making them focusable in the first place.
          role="group"
          aria-label="Session flow from goal through behavior and outcome to sentiment"
          className="block min-w-[880px] max-w-full"
        >
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
                      ? "hsl(var(--warning))"
                      : STAGE_COLOR[link.source.stage].node
                  }
                />
                <stop
                  offset="100%"
                  stopColor={
                    link.discordant
                      ? "hsl(var(--warning))"
                      : STAGE_COLOR[link.target.stage].node
                  }
                />
              </linearGradient>
            ))}
          </defs>

          <g>
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

          <g>
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

      <div
        aria-live="polite"
        className="min-h-[20px] border-t pt-2 text-[11px] text-muted-foreground"
      >
        {readout ?? "Hover or tab through a theme or ribbon to inspect it."}
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
  // The last column's labels sit to the LEFT of their bar, so the widest names
  // in the diagram never run past the right edge.
  const isLast = node.stage === "sentiment";
  const labelX = isLast ? node.x - 10 : node.x + SANKEY_NODE_WIDTH + 10;
  const anchor = isLast ? "end" : "start";

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
