import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
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
import { ChatboxTopicMapPanel } from "@/components/chatboxes/ChatboxTopicMapPanel";
import { CriterionScorecard } from "@/components/swarms/CriterionScorecard";
import { rebuildFeedback } from "@/components/shared/usage-insights/rebuild-feedback";
import type { ClusterTuning } from "@/lib/cluster-tuning";
import { cn } from "@/lib/utils";
import { Network, Workflow, X } from "lucide-react";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";

type InsightsView = "flow" | "clusters";

interface SwarmInsightsPanelProps {
  projectId: string | null;
  /**
   * When set, restrict the Sankey / scorecard / drill-down / topic map to these
   * journey-runs (a swarm wave). Omit only for legacy project-wide callers.
   */
  journeyRunIds?: readonly string[];
  /** Open a session in the Sessions browser (the parent owns the tab flip). */
  onOpenSession?: (sessionId: string) => void;
  /**
   * When false, render body content without an inner ScrollArea so a parent
   * can own scrolling. Ignored when `fillViewport` is true.
   */
  withScrollArea?: boolean;
  /**
   * Fill the parent height with a vertical stack: insights + scorecard
   * side-by-side in a capped top rail, diagram/map below (≥ half height).
   * A flow selection swaps the top rail to the session drill-down. Use this
   * on run-detail Insights.
   */
  fillViewport?: boolean;
  /**
   * Extra content for the idle top rail (e.g. findings). Hidden while a
   * flow selection's drill-down is open so the viewport stays stable.
   */
  children?: ReactNode;
}

/**
 * The Insights view for Swarms: exclusive toggle between Session flow (Sankey)
 * and Clusters (topic map), scoped to a wave's journey-runs (or the project
 * when `journeyRunIds` is omitted).
 *
 * Shares the sankey, topic map, drill-down, and selection/chip mechanics with
 * the chatbox panel — goals are journeys (deterministic), and there is no
 * feedback calibration (synthetic sessions).
 */
export function SwarmInsightsPanel({
  projectId,
  journeyRunIds,
  onOpenSession,
  withScrollArea = true,
  fillViewport = false,
  children,
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

  const [view, setView] = useState<InsightsView>("flow");
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
  // One-shot topic-map backfill per project. Server queueSwarmClusterRebuild
  // also dedupes in-flight runs; this ref is hygiene before Convex reflects
  // queued (Strict Mode / remount).
  const topicMapBackfillKeyRef = useRef<string | null>(null);

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
    setView("flow");
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

  // Preemptive topic-map backfill for legacy projects: Sankey themes exist but
  // the map blob was never written. Trigger reads latestRun from useUsageInsights
  // (breakdown); the map panel reads the same concept from getSwarmTopicMapSnapshot
  // via useTopicMap. Momentary disagreement is harmless — server dedupe absorbs
  // a double-fire. Do not thread one into the other.
  //
  // Full rebuild (themes may shift once); cache hits keep OpenRouter near zero.
  // Silent — no toast; user-initiated rebuilds go through handleRebuild.
  useEffect(() => {
    if (view !== "clusters" || !projectId) return;
    const latestRun = breakdown?.latestRun;
    if (!latestRun) return;
    if (latestRun.status !== "done" || latestRun.topicMapReady) return;
    if (topicMapBackfillKeyRef.current === projectId) return;
    topicMapBackfillKeyRef.current = projectId;
    void rebuild().catch(() => {
      // Leave the panel's failed/empty CTA to surface retry; avoid toast noise.
      topicMapBackfillKeyRef.current = null;
    });
  }, [view, projectId, breakdown?.latestRun, rebuild]);

  if (!scope) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Sign in to view swarm insights.
      </div>
    );
  }

  const viewToggle = (
    <div
      role="group"
      aria-label="Insights view"
      className="flex items-center divide-x divide-border rounded-md border border-border"
      data-testid="swarm-insights-view-toggle"
    >
      <button
        type="button"
        aria-pressed={view === "flow"}
        onClick={() => setView("flow")}
        className={cn(
          "inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium transition-colors",
          view === "flow"
            ? "bg-muted/50 text-foreground"
            : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
        )}
      >
        <Workflow className="h-3 w-3" />
        Session flow
      </button>
      <button
        type="button"
        aria-pressed={view === "clusters"}
        onClick={() => setView("clusters")}
        className={cn(
          "inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium transition-colors",
          view === "clusters"
            ? "bg-muted/50 text-foreground"
            : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
        )}
      >
        <Network className="h-3 w-3" />
        Clusters
      </button>
    </div>
  );

  const chipRow =
    dismissibleChips.length > 0 ? (
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
    ) : null;

  const sankeyBlock = (
    <>
      <ChatboxInsightsSankey
        breakdown={breakdown}
        selection={flowSelection}
        onSelectNode={handleSelectFlow}
        onSelectLink={handleSelectFlow}
        onRebuild={handleRebuild}
        rebuildBusy={rebuildBusy}
        onApplyTuning={handleApplyTuning}
        showLinkThreshold
        headerActions={viewToggle}
      />
      {chipRow}
    </>
  );

  const clustersBlock = (
    <div className="flex h-full min-h-0 flex-col">
      {chipRow}
      <div className="min-h-0 flex-1">
        <ChatboxTopicMapPanel
          scope={scope}
          journeyRunIds={stableJourneyRunIds}
          filter={filter}
          onToggleChip={handleToggleChip}
          onClearChip={handleClearChip}
          onRebuild={() => void handleRebuild()}
          rebuildBusy={rebuildBusy}
          onOpenSession={onOpenSession}
          headerActions={viewToggle}
        />
      </div>
    </div>
  );

  const scorecardBlock = (
    <CriterionScorecard
      facets={breakdown?.criterionBreakdown}
      filter={filter}
      onToggleChip={handleToggleChip}
    />
  );

  const drilldownBlock = (
    <ChatboxGoalOutcomeDrilldown
      scope={scope}
      selection={flowSelection}
      filter={filter}
      onClose={handleCloseFlow}
      onOpenSession={(sessionId) => onOpenSession?.(sessionId)}
    />
  );

  if (fillViewport) {
    const selectionOpen = flowSelection !== null;
    // Vertical stack: answer (insights ∥ scorecard) on top in a capped rail,
    // diagram below with ≥ half the height so the flow keeps presence.
    return (
      <div
        className="flex h-full min-h-0 flex-col gap-3 overflow-hidden"
        data-testid="swarm-insights-panel"
      >
        <div
          className="flex max-h-[45%] min-h-[11rem] shrink-0 flex-col gap-3 overflow-y-auto sm:flex-row sm:items-stretch"
          data-testid="swarm-insights-rail"
        >
          {selectionOpen ? (
            <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
              {drilldownBlock}
            </div>
          ) : (
            <>
              {children ? (
                <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                  {children}
                </div>
              ) : null}
              <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                {scorecardBlock}
              </div>
            </>
          )}
        </div>
        <div className="min-h-[50%] min-w-0 flex-1 overflow-hidden border-t border-border/40 pt-3">
          {view === "clusters" ? clustersBlock : sankeyBlock}
        </div>
      </div>
    );
  }

  const body =
    view === "clusters" ? (
      clustersBlock
    ) : (
      <>
        {sankeyBlock}
        {scorecardBlock}
        {drilldownBlock}
        {children}
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
