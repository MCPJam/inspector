import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "@/lib/toast";
import {
  EMPTY_USAGE_FILTER,
  chipKey,
  isSameSelection,
  removeChipByKey,
  removeChipsByKeys,
  selectionChipsToAdd,
  toggleChip,
  type InsightsSelection,
  type UsageFilterChip,
  type UsageFilterState,
} from "@/hooks/chatbox-usage-filters";
import { useUsageInsights, type InsightsScope } from "@/hooks/useUsageInsights";
import { ChatboxInsightsSankey } from "@/components/chatboxes/ChatboxInsightsSankey";
import { ChatboxGoalOutcomeDrilldown } from "@/components/chatboxes/ChatboxGoalOutcomeDrilldown";
import { CriterionScorecard } from "@/components/swarms/CriterionScorecard";
import { rebuildFeedback } from "@/components/shared/usage-insights/rebuild-feedback";
import type { ClusterTuning } from "@/lib/cluster-tuning";
import { X } from "lucide-react";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";

interface SwarmInsightsPanelProps {
  projectId: string | null;
  /**
   * When set, restrict the Sankey / scorecard / drill-down to these
   * journey-runs (a swarm wave). Omit only for legacy project-wide callers.
   */
  journeyRunIds?: readonly string[];
  /** Open a session in the Sessions browser (the parent owns the tab flip). */
  onOpenSession?: (sessionId: string) => void;
  /**
   * When false, render body content without an inner ScrollArea so a parent
   * can own scrolling (e.g. run detail with personas + findings around this
   * panel). Default true.
   */
  withScrollArea?: boolean;
}

/**
 * The Insights view for Swarms: the same four-stage session flow the chatbox
 * Insights tab renders, scoped to a wave's journey-runs (or the project when
 * `journeyRunIds` is omitted).
 *
 * Layout leads with the flow diagram — it is what this tab uniquely offers.
 * The rubric scorecard sits below it as the cohort-slicing tool: its counts
 * are filter chips over the flow and the drill-down, which is why it lives on
 * this tab at all (the headline score itself is Overview material).
 *
 * Shares the sankey, the drill-down, and the selection/chip mechanics with the
 * chatbox panel — the one visible difference is the first column's header:
 * swarm goals are journeys, assigned deterministically rather than clustered,
 * so the column is named for what it actually is.
 *
 * No topic map and no feedback calibration: both are chatbox-surface features
 * (goal embeddings / visitor feedback) that swarm sessions don't have.
 */
export function SwarmInsightsPanel({
  projectId,
  journeyRunIds,
  onOpenSession,
  withScrollArea = true,
}: SwarmInsightsPanelProps) {
  const journeyRunIdsKey = journeyRunIds?.join("\0") ?? "";
  const stableJourneyRunIds = useMemo(
    () => (journeyRunIds?.length ? [...journeyRunIds] : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- identity via key
    [journeyRunIdsKey],
  );

  const scope = useMemo<InsightsScope | null>(
    () =>
      projectId
        ? {
            kind: "swarm",
            projectId,
            ...(stableJourneyRunIds ? { journeyRunIds: stableJourneyRunIds } : {}),
          }
        : null,
    [projectId, stableJourneyRunIds],
  );

  const [filter, setFilter] = useState<UsageFilterState>(EMPTY_USAGE_FILTER);
  const [flowSelection, setFlowSelection] = useState<InsightsSelection | null>(
    null,
  );
  // The chips the flow actually ADDED — ownership, not implication — mirroring
  // the chatbox panel's contract so teardown never deletes a chip another
  // writer put there.
  const [flowOwnedKeys, setFlowOwnedKeys] = useState<string[]>([]);
  const [rebuildBusy, setRebuildBusy] = useState(false);
  const rebuildInFlightRef = useRef(false);

  // Reset on project / wave switches: a selected flow node names a cluster
  // belonging to the previous cohort.
  const prevCohortKeyRef = useRef(`${projectId ?? ""}\0${journeyRunIdsKey}`);
  useEffect(() => {
    const nextKey = `${projectId ?? ""}\0${journeyRunIdsKey}`;
    if (prevCohortKeyRef.current === nextKey) return;
    prevCohortKeyRef.current = nextKey;
    setFilter(EMPTY_USAGE_FILTER);
    setFlowSelection(null);
    setFlowOwnedKeys([]);
    rebuildInFlightRef.current = false;
    setRebuildBusy(false);
  }, [projectId, journeyRunIdsKey]);

  // The selection's own chips must not reach the breakdown query — they are
  // the diagram's own output, and feeding them back collapses the diagram to
  // the selected path. Same ownership subtraction as the chatbox panel.
  const breakdownFilter = useMemo(
    () => removeChipsByKeys(filter, flowOwnedKeys),
    [filter, flowOwnedKeys],
  );

  const { breakdown, rebuild } = useUsageInsights({
    scope,
    filters: breakdownFilter,
    threadsEnabled: false,
    breakdownEnabled: scope !== null,
  });

  const handleSelectFlow = useCallback(
    (next: InsightsSelection) => {
      const isAlreadyOpen = isSameSelection(flowSelection, next);
      const cleared = removeChipsByKeys(filter, flowOwnedKeys);
      if (isAlreadyOpen) {
        setFilter(cleared);
        setFlowSelection(null);
        setFlowOwnedKeys([]);
        return;
      }
      const added = selectionChipsToAdd(cleared, next);
      setFilter({ ...cleared, chips: [...cleared.chips, ...added] });
      setFlowSelection(next);
      setFlowOwnedKeys(added.map(chipKey));
    },
    [filter, flowSelection, flowOwnedKeys],
  );

  // Criterion chips are ORDINARY filter chips, not flow-owned: they are the
  // user's own narrowing, so they feed the breakdown query and narrow the
  // sankey. Only the flow's self-generated chips are subtracted above.
  const handleToggleChip = useCallback(
    (chip: UsageFilterChip) => setFilter((prev) => toggleChip(prev, chip)),
    [],
  );
  const handleClearChip = useCallback(
    (key: string) => setFilter((prev) => removeChipByKey(prev, key)),
    [],
  );

  // The chips shown as dismissible pills — everything EXCEPT the ones the flow
  // put there. Those are already expressed by the selected path in the
  // diagram, and offering a second way to remove them would let the pill and
  // the diagram disagree about what is selected.
  const dismissibleChips = useMemo(() => {
    const owned = new Set(flowOwnedKeys);
    return filter.chips.filter((chip) => !owned.has(chipKey(chip)));
  }, [filter.chips, flowOwnedKeys]);

  const handleCloseFlow = useCallback(() => {
    setFilter((prev) => removeChipsByKeys(prev, flowOwnedKeys));
    setFlowSelection(null);
    setFlowOwnedKeys([]);
  }, [flowOwnedKeys]);

  const handleRebuild = useCallback(
    async (args?: { tuning?: ClusterTuning; force?: boolean }) => {
      if (rebuildInFlightRef.current) return;
      rebuildInFlightRef.current = true;
      setRebuildBusy(true);
      try {
        const result = await rebuild(args);
        const { tone, message } = rebuildFeedback(result);
        toast[tone](message);
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Rebuild failed. Try again in a few minutes.",
        );
      } finally {
        rebuildInFlightRef.current = false;
        setRebuildBusy(false);
      }
    },
    [rebuild],
  );

  const handleApplyTuning = useCallback(
    (tuning: ClusterTuning, opts?: { force?: boolean }) => {
      void handleRebuild({ tuning, ...opts });
    },
    [handleRebuild],
  );

  if (!scope) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Sign in to view swarm insights.
      </div>
    );
  }

  const body = (
    <>
      <ChatboxInsightsSankey
        breakdown={breakdown}
        selection={flowSelection}
        onSelectNode={handleSelectFlow}
        onSelectLink={handleSelectFlow}
        onRebuild={handleRebuild}
        rebuildBusy={rebuildBusy}
        onApplyTuning={handleApplyTuning}
        // Swarm insights build no topic map, so link distance would be a knob
        // with nothing on the other end of it.
        showLinkThreshold={false}
      />
      {dismissibleChips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 px-5 py-2">
          {dismissibleChips.map((chip) => {
            const key = chipKey(chip);
            const label =
              chip.kind === "cluster"
                ? (chip.label ?? "Cluster")
                : (chip.label ?? `${chip.key}: ${chip.value}`);
            return (
              <button
                key={key}
                type="button"
                onClick={() => handleClearChip(key)}
                className="inline-flex items-center gap-1 rounded-full border bg-muted/50 px-2 py-0.5 text-xs hover:bg-muted"
              >
                <span>{label}</span>
                <X className="size-3" />
              </button>
            );
          })}
        </div>
      ) : null}
      <CriterionScorecard
        facets={breakdown?.criterionBreakdown}
        filter={filter}
        onToggleChip={handleToggleChip}
      />
      <ChatboxGoalOutcomeDrilldown
        scope={scope}
        selection={flowSelection}
        filter={filter}
        onClose={handleCloseFlow}
        onOpenSession={(sessionId) => onOpenSession?.(sessionId)}
      />
    </>
  );

  if (!withScrollArea) {
    return <div data-testid="swarm-insights-panel">{body}</div>;
  }

  return (
    <div className="h-full" data-testid="swarm-insights-panel">
      <ScrollArea className="h-full">{body}</ScrollArea>
    </div>
  );
}
