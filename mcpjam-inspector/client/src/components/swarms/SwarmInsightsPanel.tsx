import { useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  chipKey,
  isSameSelection,
  type InsightsSelection,
  type ThemeRef,
  type UsageFilterChip,
} from "@/hooks/chatbox-usage-filters";
import {
  useInsightsFlowController,
  useInsightsRebuild,
} from "@/hooks/useInsightsFlowController";
import { useUsageInsights, type InsightsScope } from "@/hooks/useUsageInsights";
import { ChatboxInsightsSankey } from "@/components/chatboxes/ChatboxInsightsSankey";
import { ChatboxGoalOutcomeDrilldown } from "@/components/chatboxes/ChatboxGoalOutcomeDrilldown";
import { ChatboxTopicMapPanel } from "@/components/chatboxes/ChatboxTopicMapPanel";
import { CriterionScorecard } from "@/components/swarms/CriterionScorecard";
import { InsightsStatline } from "@/components/shared/usage-insights/InsightsStatline";
import { InsightsViewToggle } from "@/components/shared/usage-insights/InsightsViewToggle";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";

interface SwarmInsightsPanelProps {
  projectId: string | null;
  /**
   * When set, restrict the Sankey / scorecard / drill-down / topic map to these
   * journey-runs (a swarm wave). Omit only for legacy project-wide callers.
   */
  journeyRunIds?: readonly string[];
  /** Open a session in the Sessions browser (the parent owns the tab flip). */
  onOpenSession?: (sessionId: string) => void;
  /** Open the Sessions tab without selecting a particular session. */
  onOpenSessionsTab?: () => void;
  /** Selection restored from the `sel` URL parameter. */
  urlSelection?: ReadonlyArray<Pick<ThemeRef, "dimension" | "clusterId">> | null;
  /** Persist flow selection changes in the owning route. */
  onSelectionChange?: (
    themes: ReadonlyArray<Pick<ThemeRef, "dimension" | "clusterId">> | null,
  ) => void;
  /** Leading statline content supplied by the run detail page. */
  personasSlot?: ReactNode;
  /** Pattern summary chip supplied by the run detail page. */
  strugglesSlot?: ReactNode;
  /** Extra content shown below the rubric scorecard in its popover. */
  checksExtras?: ReactNode;
  /**
   * When false, render body content without an inner ScrollArea so a parent
   * can own scrolling. Ignored when `fillViewport` is true.
   */
  withScrollArea?: boolean;
  /**
   * Fill the parent height: compact statline on top, diagram/map absorbing the
   * rest (Session flow re-lays to the pane height). A flow selection opens the
   * session drill-down beside the chart. Use this on run-detail Insights.
   */
  fillViewport?: boolean;
}

/**
 * The Insights view for Swarms: exclusive toggle between Session flow (Sankey)
 * and Clusters (topic map), scoped to a wave's journey-runs (or the project
 * when `journeyRunIds` is omitted).
 *
 * Shares flow/selection/rebuild orchestration with User Testing via
 * `useInsightsFlowController` — goals are journeys (deterministic), and there
 * is no feedback calibration (synthetic sessions).
 */
export function SwarmInsightsPanel({
  projectId,
  journeyRunIds,
  onOpenSession,
  onOpenSessionsTab,
  urlSelection,
  onSelectionChange,
  personasSlot,
  strugglesSlot,
  checksExtras,
  withScrollArea = true,
  fillViewport = false,
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

  const cohortKey = `${projectId ?? ""}\0${journeyRunIdsKey}`;

  const flow = useInsightsFlowController({
    cohortKey,
    onSelectionChange,
  });

  const { breakdown, rebuild } = useUsageInsights({
    scope,
    filters: flow.breakdownFilter,
    threadsEnabled: false,
    breakdownEnabled: scope !== null,
  });

  const { rebuildBusy, handleRebuild, handleApplyTuning } = useInsightsRebuild(
    rebuild,
    cohortKey,
  );

  const urlSelectionKey = urlSelection
    ?.map((theme) => `${theme.dimension}:${theme.clusterId}`)
    .join("\0");
  const resolvedUrlSelection = useMemo<InsightsSelection | null>(() => {
    if (!urlSelection || urlSelection.length === 0) return null;
    const nodes = breakdown?.sankey?.nodes ?? [];
    return {
      themes: urlSelection.map((theme) => {
        const node = nodes.find(
          (candidate) =>
            candidate.stage === theme.dimension &&
            candidate.key === theme.clusterId,
        );
        return { ...theme, ...(node ? { label: node.label } : {}) };
      }),
    };
  }, [urlSelectionKey, breakdown?.sankey]);

  // URL state is an external owner. Reconcile only when that external value
  // changes, so a local click is not cleared before navigate updates it.
  useEffect(() => {
    if (urlSelection === undefined) return;
    if (resolvedUrlSelection === null) {
      if (flow.flowSelectionRef.current !== null) {
        flow.commitSelection(null, { silent: true });
      }
      return;
    }
    if (isSameSelection(flow.flowSelectionRef.current, resolvedUrlSelection)) {
      // The URL identity is unchanged, but the Sankey may just have supplied
      // labels for a selection restored before the breakdown loaded.
      flow.setFlowSelection(resolvedUrlSelection);
      return;
    }
    flow.commitSelection(resolvedUrlSelection, { silent: true });
  }, [
    urlSelectionKey,
    resolvedUrlSelection,
    urlSelection,
    flow.commitSelection,
    flow.setFlowSelection,
    flow.flowSelectionRef,
  ]);

  // One-shot topic-map backfill per project. Server queueSwarmClusterRebuild
  // also dedupes in-flight runs; this ref is hygiene before Convex reflects
  // queued (Strict Mode / remount).
  const topicMapBackfillKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (flow.view !== "clusters" || !projectId) return;
    const latestRun = breakdown?.latestRun;
    if (!latestRun) return;
    if (latestRun.status !== "done" || latestRun.topicMapReady) return;
    if (topicMapBackfillKeyRef.current === projectId) return;
    topicMapBackfillKeyRef.current = projectId;
    void rebuild().catch(() => {
      // Leave the panel's failed/empty CTA to surface retry; avoid toast noise.
      topicMapBackfillKeyRef.current = null;
    });
  }, [flow.view, projectId, breakdown?.latestRun, rebuild]);

  if (!scope) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Sign in to view swarm insights.
      </div>
    );
  }

  const viewToggle = (
    <InsightsViewToggle
      view={flow.view}
      onChange={flow.setView}
      testId="swarm-insights-view-toggle"
    />
  );

  const chipRow =
    flow.dismissibleChips.length > 0 ? (
      <div className="flex flex-wrap items-center gap-1.5 px-5 py-2">
        {flow.dismissibleChips.map((chip: UsageFilterChip) => {
          const key = chipKey(chip);
          const label =
            chip.kind === "cluster"
              ? (chip.label ?? "Cluster")
              : (chip.label ?? `${chip.key}: ${chip.value}`);
          return (
            <button
              key={key}
              type="button"
              onClick={() => flow.handleClearChip(key)}
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
    <div
      className={cn(
        fillViewport && "flex h-full min-h-0 flex-col overflow-hidden",
      )}
    >
      <div className={cn(fillViewport && "min-h-0 flex-1 overflow-hidden")}>
        <ChatboxInsightsSankey
          breakdown={breakdown}
          selection={flow.flowSelection}
          onSelectNode={flow.handleSelectFlow}
          onSelectLink={flow.handleSelectFlow}
          onRebuild={handleRebuild}
          rebuildBusy={rebuildBusy}
          onApplyTuning={handleApplyTuning}
          showLinkThreshold
          headerActions={fillViewport ? undefined : viewToggle}
          fillHeight={fillViewport}
        />
      </div>
      {chipRow}
    </div>
  );

  const clustersBlock = (
    <div className="flex h-full min-h-0 flex-col">
      {chipRow}
      <div className="min-h-0 flex-1">
        <ChatboxTopicMapPanel
          scope={scope}
          journeyRunIds={stableJourneyRunIds}
          filter={flow.filter}
          onToggleChip={flow.handleToggleChip}
          onClearChip={flow.handleClearChip}
          onRebuild={() => void handleRebuild()}
          rebuildBusy={rebuildBusy}
          onOpenSession={onOpenSession}
          headerActions={fillViewport ? undefined : viewToggle}
        />
      </div>
    </div>
  );

  const scorecardBlock = (
    <CriterionScorecard
      facets={breakdown?.criterionBreakdown}
      filter={flow.filter}
      onToggleChip={flow.handleToggleChip}
    />
  );

  const drilldownBlock = (
    <ChatboxGoalOutcomeDrilldown
      scope={scope}
      selection={flow.flowSelection}
      filter={flow.filter}
      onClose={flow.handleCloseFlow}
      onOpenSession={(sessionId) => onOpenSession?.(sessionId)}
    />
  );

  if (fillViewport) {
    const selectionOpen = flow.flowSelection !== null;
    return (
      <div
        className="flex h-full min-h-0 flex-col gap-2 overflow-hidden"
        data-testid="swarm-insights-panel"
      >
        <InsightsStatline
          breakdown={breakdown}
          filter={flow.filter}
          flowSelection={flow.flowSelection}
          onSelectFlow={flow.handleSelectFlow}
          onToggleChip={flow.handleToggleChip}
          onOpenSessionsTab={onOpenSessionsTab}
          leadingSlot={personasSlot}
          strugglesSlot={strugglesSlot}
          checksExtras={checksExtras}
          trailing={viewToggle}
          testId="swarm-insights-statline"
        />
        <div className="relative flex min-h-0 flex-1 overflow-hidden">
          <div className="min-w-0 flex-1 overflow-hidden">
            {flow.view === "clusters" ? clustersBlock : sankeyBlock}
          </div>
          {flow.view === "flow" && selectionOpen ? (
            <div
              className="absolute inset-0 z-10 bg-background sm:static sm:w-[22rem] lg:w-[24rem] sm:shrink-0 sm:border-l sm:border-border/40"
              data-testid="swarm-insights-drill-panel"
            >
              <ChatboxGoalOutcomeDrilldown
                scope={scope}
                selection={flow.flowSelection}
                filter={flow.filter}
                variant="panel"
                onClose={flow.handleCloseFlow}
                onOpenSession={(sessionId) => onOpenSession?.(sessionId)}
                footer={
                  onOpenSessionsTab ? (
                    <button
                      type="button"
                      className="self-start text-xs font-medium text-primary hover:underline"
                      onClick={onOpenSessionsTab}
                    >
                      Open in Sessions tab →
                    </button>
                  ) : null
                }
              />
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  const body =
    flow.view === "clusters" ? (
      clustersBlock
    ) : (
      <>
        {sankeyBlock}
        {scorecardBlock}
        {drilldownBlock}
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
