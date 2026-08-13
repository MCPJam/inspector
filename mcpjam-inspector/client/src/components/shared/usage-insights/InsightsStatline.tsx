import type { ReactNode } from "react";
import {
  isSameSelection,
  type InsightsSelection,
} from "@/hooks/chatbox-usage-filters";
import type { UsageBreakdown } from "@/hooks/useUsageInsights";
import {
  selectionForNode,
  stageValueLabel,
} from "@/components/shared/usage-insights/insights-sankey";
import { cn } from "@/lib/utils";

const CHIP_CLASS =
  "inline-flex min-w-0 items-center gap-1 rounded-md border border-border/50 bg-muted/25 px-2 py-0.5 text-xs font-medium tabular-nums transition-colors hover:bg-muted/50";

const STAGE_LABELS: Record<"outcome" | "sentiment", string> = {
  outcome: "Outcome",
  sentiment: "Sentiment",
};

interface InsightsStatlineProps {
  breakdown: UsageBreakdown | null | undefined;
  flowSelection: InsightsSelection | null;
  onSelectFlow: (selection: InsightsSelection) => void;
  /** Leading chips (e.g. Swarm personas). */
  leadingSlot?: ReactNode;
  /** Pattern / struggles chip (Swarm). */
  strugglesSlot?: ReactNode;
  testId?: string;
}

function topClickableNode(
  breakdown: UsageBreakdown | null | undefined,
  stage: "outcome" | "sentiment",
) {
  const sankey = breakdown?.sankey;
  if (!sankey || (breakdown.totalSessions ?? 0) <= 0) return null;
  const nodes = sankey.nodes
    .filter((node) => node.stage === stage && node.clickable)
    .sort((a, b) => b.count - a.count);
  const node = nodes[0];
  if (!node) return null;
  const stageTotal = sankey.nodes
    .filter((candidate) => candidate.stage === stage)
    .reduce((sum, candidate) => sum + candidate.count, 0);
  if (stageTotal <= 0) return null;
  const selection = selectionForNode(node);
  if (!selection) return null;
  return {
    node,
    selection,
    share: Math.round((node.count / stageTotal) * 100),
  };
}

function FlowFacetChip({
  stage,
  value,
  flowSelection,
  onSelectFlow,
}: {
  stage: "outcome" | "sentiment";
  value: NonNullable<ReturnType<typeof topClickableNode>>;
  flowSelection: InsightsSelection | null;
  onSelectFlow: (selection: InsightsSelection) => void;
}) {
  const label = `${stageValueLabel(value.node)} ${value.share}%`;
  return (
    <button
      type="button"
      className={cn(CHIP_CLASS, "max-w-[16rem]")}
      title={`${STAGE_LABELS[stage]}: ${label}`}
      aria-label={`${STAGE_LABELS[stage]}: ${label}`}
      aria-pressed={isSameSelection(flowSelection, value.selection)}
      onClick={() => onSelectFlow(value.selection)}
    >
      <span className="truncate">{label}</span>
    </button>
  );
}

/**
 * Compact Insights chrome shared by Swarm run detail and User Testing:
 * top outcome / sentiment chips (and surface-specific slots).
 * View toggle + freshness live in the chart header beside the Sankey legend.
 */
export function InsightsStatline({
  breakdown,
  flowSelection,
  onSelectFlow,
  leadingSlot,
  strugglesSlot,
  testId = "insights-statline",
}: InsightsStatlineProps) {
  const outcome = topClickableNode(breakdown, "outcome");
  const sentiment = topClickableNode(breakdown, "sentiment");

  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-1.5"
      data-testid={testId}
    >
      {leadingSlot}
      {outcome ? (
        <FlowFacetChip
          stage="outcome"
          value={outcome}
          flowSelection={flowSelection}
          onSelectFlow={onSelectFlow}
        />
      ) : null}
      {sentiment ? (
        <FlowFacetChip
          stage="sentiment"
          value={sentiment}
          flowSelection={flowSelection}
          onSelectFlow={onSelectFlow}
        />
      ) : null}
      {strugglesSlot}
    </div>
  );
}
