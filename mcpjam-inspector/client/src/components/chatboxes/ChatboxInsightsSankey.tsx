import { useMemo, useState } from "react";
import { Layer, Rectangle, ResponsiveContainer, Sankey } from "recharts";
import { AlertTriangle, Info, RefreshCw, Target } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import {
  SIGNALS_VERSION_WITH_SENTIMENT,
  type InsightsSankeyNode,
  type UsageBreakdown,
} from "@/hooks/useUsageInsights";
import {
  isSameSelection,
  type InsightsSelection,
} from "@/hooks/chatbox-usage-filters";
import {
  STAGE_ORDER,
  STAGE_TITLES,
  selectionForLink,
  selectionForNode,
  stageShare,
  stageValueLabel,
  toRechartsSankey,
} from "@/components/chatboxes/insights-sankey";

interface ChatboxInsightsSankeyProps {
  breakdown: UsageBreakdown | null | undefined;
  /** Currently open selection, so the clicked node can read as selected. */
  selection: InsightsSelection | null;
  onSelectNode: (selection: InsightsSelection) => void;
  onSelectLink: (selection: InsightsSelection) => void;
  onRebuild: () => void;
  rebuildBusy: boolean;
}

/** Rows of ~34px plus padding; tall enough that labels never collide. */
function chartHeight(stageCounts: number[]): number {
  return Math.max(300, Math.max(...stageCounts, 1) * 34 + 40);
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
 * Session flow: goal → behavior → outcome → sentiment.
 *
 * Two of the four stages are deterministic (behavior is read off the transcript,
 * and an unrecovered tool error forces the outcome), and the legend says so —
 * a reader deciding whether to trust a column needs to know which ones a model
 * produced.
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

  const sankey = breakdown?.sankey;
  const scan = breakdown?.scan;
  const signalsVersion = breakdown?.latestRun?.signalsVersion ?? null;

  const data = useMemo(
    () => (sankey ? toRechartsSankey(sankey) : null),
    [sankey],
  );

  if (!breakdown) {
    return (
      <div className="flex items-center justify-center px-5 py-10 text-xs text-muted-foreground">
        Loading session flow…
      </div>
    );
  }

  if (!sankey || sankey.nodes.length === 0 || !data) {
    return (
      <div className="flex flex-col items-center gap-2 px-5 py-10 text-center">
        <Target className="h-6 w-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No session flow yet</p>
        <p className="max-w-md text-xs text-muted-foreground">
          {signalsVersion === null
            ? "The last rebuild ran before session signals existed. Rebuild clusters to extract goals, behaviors, outcomes, and sentiment."
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

  const needsSentimentRebuild =
    signalsVersion !== null && signalsVersion < SIGNALS_VERSION_WITH_SENTIMENT;

  const stageCounts = STAGE_ORDER.map(
    (stage) => sankey.nodes.filter((node) => node.stage === stage).length,
  );

  const handleNodeClick = (node: InsightsSankeyNode) => {
    const next = selectionForNode(node);
    if (next) onSelectNode(next);
  };

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
              Every session takes one path through all four stages. Behavior is
              read directly off the transcript, and a session whose tool call
              failed without recovering is recorded as errored regardless of
              what the model concluded. Goal, outcome, and sentiment are model
              judgements. Sessions still recent enough that they may not have
              finished are held at &ldquo;unclear&rdquo;.
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded-full bg-warning" />
            Outcome and sentiment disagree
          </span>
          {sankey.foldedGoalCount > 0 ? (
            <span>
              {sankey.foldedGoalCount} smaller{" "}
              {sankey.foldedGoalCount === 1 ? "goal" : "goals"} folded
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

      {needsSentimentRebuild ? (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground"
        >
          <span>
            This chatbox was last analyzed before sentiment existed, so every
            session sits in the unlabeled sentiment node.
          </span>
          <RebuildButton
            onRebuild={onRebuild}
            busy={rebuildBusy}
            label="Rebuild for sentiment"
          />
        </div>
      ) : null}

      <div className="grid grid-cols-4 gap-2 pt-1 text-[11px] font-medium text-muted-foreground">
        {STAGE_ORDER.map((stage) => (
          <div key={stage} className="flex items-center gap-1.5">
            {STAGE_TITLES[stage]}
            <span className="rounded-sm bg-muted px-1 py-px text-[9px] font-normal uppercase tracking-wide">
              {stage === "behavior" ? "from transcript" : "model"}
            </span>
          </div>
        ))}
      </div>

      <div style={{ height: chartHeight(stageCounts) }}>
        <ResponsiveContainer width="100%" height="100%">
          <Sankey
            data={data}
            sort={false}
            nodePadding={14}
            nodeWidth={10}
            margin={{ top: 8, right: 8, bottom: 8, left: 8 }}
            link={
              <SankeyLink
                hovered={hovered}
                onHover={setHovered}
                nodes={data.nodes}
                onSelect={onSelectLink}
              />
            }
            node={
              <SankeyNode
                sankey={sankey}
                selection={selection}
                onSelect={handleNodeClick}
              />
            }
          />
        </ResponsiveContainer>
      </div>
    </div>
  );
}

type LinkRenderProps = {
  sourceX?: number;
  targetX?: number;
  sourceY?: number;
  targetY?: number;
  sourceControlX?: number;
  targetControlX?: number;
  linkWidth?: number;
  index?: number;
  payload?: {
    value: number;
    sourceId: string;
    targetId: string;
    discordant: boolean;
  };
  hovered: string | null;
  onHover: (id: string | null) => void;
  nodes: Array<{ node: InsightsSankeyNode }>;
  onSelect: (selection: InsightsSelection) => void;
};

function SankeyLink({
  sourceX = 0,
  targetX = 0,
  sourceY = 0,
  targetY = 0,
  sourceControlX = 0,
  targetControlX = 0,
  linkWidth = 0,
  payload,
  hovered,
  onHover,
  nodes,
  onSelect,
}: LinkRenderProps) {
  if (!payload) return null;
  const id = `${payload.sourceId}→${payload.targetId}`;
  const isHovered = hovered === id;
  const discordant = payload.discordant;

  const source = nodes.find((entry) => entry.node.id === payload.sourceId);
  const target = nodes.find((entry) => entry.node.id === payload.targetId);
  const selection =
    source && target ? selectionForLink(source.node, target.node) : null;

  return (
    <Layer>
      <path
        d={`M${sourceX},${sourceY}C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`}
        fill="none"
        stroke={
          discordant ? "hsl(var(--warning))" : "hsl(var(--muted-foreground))"
        }
        strokeWidth={linkWidth}
        strokeOpacity={isHovered ? 0.55 : discordant ? 0.35 : 0.16}
        style={{ cursor: selection ? "pointer" : "default" }}
        onMouseEnter={() => onHover(id)}
        onMouseLeave={() => onHover(null)}
        onClick={() => {
          if (selection) onSelect(selection);
        }}
      >
        <title>
          {`${payload.value} ${payload.value === 1 ? "session" : "sessions"}${
            discordant ? " — outcome and sentiment disagree" : ""
          }`}
        </title>
      </path>
    </Layer>
  );
}

type NodeRenderProps = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  containerWidth?: number;
  payload?: { node: InsightsSankeyNode };
  sankey: NonNullable<UsageBreakdown["sankey"]>;
  selection: InsightsSelection | null;
  onSelect: (node: InsightsSankeyNode) => void;
};

function SankeyNode({
  x = 0,
  y = 0,
  width = 0,
  height = 0,
  containerWidth = 0,
  payload,
  sankey,
  selection,
  onSelect,
}: NodeRenderProps) {
  if (!payload?.node) return null;
  const node = payload.node;
  const share = stageShare(sankey, node);
  const isSelected =
    selection !== null && isSameSelection(selection, selectionForNode(node));
  // Labels sit outside the bar, flipping to the left edge for the last stage so
  // they never run off the container.
  const isLastStage = x + width + 6 > containerWidth - 120;
  const textAnchor = isLastStage ? "end" : "start";
  const labelX = isLastStage ? x - 6 : x + width + 6;

  return (
    <Layer
      style={{ cursor: node.clickable ? "pointer" : "default" }}
      onClick={() => {
        if (node.clickable) onSelect(node);
      }}
    >
      <Rectangle
        x={x}
        y={y}
        width={width}
        height={height}
        radius={2}
        fill={
          isSelected
            ? "hsl(var(--primary))"
            : node.clickable
            ? "hsl(var(--muted-foreground))"
            : "hsl(var(--muted-foreground) / 0.4)"
        }
        aria-label={`${stageValueLabel(node)}: ${node.count} sessions`}
      />
      <text
        x={labelX}
        y={y + height / 2}
        textAnchor={textAnchor}
        dominantBaseline="middle"
        className="pointer-events-none fill-foreground text-[11px]"
      >
        {stageValueLabel(node)}
      </text>
      <text
        x={labelX}
        y={y + height / 2 + 12}
        textAnchor={textAnchor}
        dominantBaseline="middle"
        className="pointer-events-none fill-muted-foreground text-[10px]"
      >
        {node.count.toLocaleString()} · {share}%
      </text>
    </Layer>
  );
}
