import type { ReactNode } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import {
  isSameSelection,
  type InsightsSelection,
  type UsageFilterChip,
  type UsageFilterState,
} from "@/hooks/chatbox-usage-filters";
import type { UsageBreakdown } from "@/hooks/useUsageInsights";
import {
  selectionForNode,
  stageValueLabel,
} from "@/components/chatboxes/insights-sankey";
import {
  CriterionScorecard,
  summarizeCriterionFacets,
} from "@/components/swarms/CriterionScorecard";
import { cn } from "@/lib/utils";

const CHIP_CLASS =
  "inline-flex min-w-0 items-center gap-1 rounded-md border border-border/50 bg-muted/25 px-2 py-0.5 text-xs font-medium tabular-nums transition-colors hover:bg-muted/50";

const STAGE_LABELS: Record<"outcome" | "sentiment", string> = {
  outcome: "Outcome",
  sentiment: "Sentiment",
};

interface InsightsStatlineProps {
  breakdown: UsageBreakdown | null | undefined;
  filter: UsageFilterState;
  flowSelection: InsightsSelection | null;
  onSelectFlow: (selection: InsightsSelection) => void;
  onToggleChip: (chip: UsageFilterChip) => void;
  onOpenSessionsTab?: () => void;
  /** Leading chips (e.g. Swarm personas). */
  leadingSlot?: ReactNode;
  /** Pattern / struggles chip (Swarm). */
  strugglesSlot?: ReactNode;
  /** Extra content below the rubric scorecard in its popover. */
  checksExtras?: ReactNode;
  trailing?: ReactNode;
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
 * session count, top outcome / sentiment, optional Checks, trailing toggle.
 */
export function InsightsStatline({
  breakdown,
  filter,
  flowSelection,
  onSelectFlow,
  onToggleChip,
  onOpenSessionsTab,
  leadingSlot,
  strugglesSlot,
  checksExtras,
  trailing,
  testId = "insights-statline",
}: InsightsStatlineProps) {
  const outcome = topClickableNode(breakdown, "outcome");
  const sentiment = topClickableNode(breakdown, "sentiment");
  const facets = breakdown?.criterionBreakdown ?? [];
  const summary = facets.length ? summarizeCriterionFacets(facets) : null;
  const checksLabel = summary
    ? summary.totalFail > 0
      ? `✕ Checks ${summary.cleanCount}/${facets.length} · ${summary.totalFail} failing`
      : `✓ Checks ${summary.cleanCount}/${facets.length}`
    : checksExtras
      ? "Checks"
      : null;

  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-1.5"
      data-testid={testId}
    >
      {leadingSlot}
      <button
        type="button"
        className={CHIP_CLASS}
        onClick={onOpenSessionsTab}
        disabled={!onOpenSessionsTab}
      >
        {breakdown?.totalSessions ?? 0} sessions
      </button>
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
      {checksLabel ? (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                CHIP_CLASS,
                Boolean(summary && summary.totalFail > 0) &&
                  "border-destructive/50 bg-destructive/10 text-destructive hover:bg-destructive/20",
              )}
              aria-label={checksLabel}
            >
              {checksLabel}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[26rem] max-w-[90vw] p-0">
            <div className="flex max-h-[60vh] min-h-0 flex-col overflow-y-auto">
              <CriterionScorecard
                facets={facets}
                filter={filter}
                onToggleChip={onToggleChip}
              />
              {checksExtras}
            </div>
          </PopoverContent>
        </Popover>
      ) : null}
      {strugglesSlot}
      {trailing ? <div className="ml-auto">{trailing}</div> : null}
    </div>
  );
}
