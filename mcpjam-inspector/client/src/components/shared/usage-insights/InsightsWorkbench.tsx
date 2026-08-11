import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  chipKey,
  isSameSelection,
  type InsightsSelection,
  type ThemeRef,
  type UsageFilterChip,
  type UsageFilterState,
} from "@/hooks/chatbox-usage-filters";
import {
  useInsightsFlowController,
  useInsightsRebuild,
  type InsightsView,
} from "@/hooks/useInsightsFlowController";
import {
  useUsageInsights,
  type InsightsScope,
  type UsageBreakdown,
} from "@/hooks/useUsageInsights";
import { SessionFlowSankey } from "@/components/shared/usage-insights/SessionFlowSankey";
import { GoalOutcomeDrilldown } from "@/components/shared/usage-insights/GoalOutcomeDrilldown";
import { TopicMapPanel } from "@/components/shared/usage-insights/TopicMapPanel";
import { InsightsStatline } from "@/components/shared/usage-insights/InsightsStatline";
import { InsightsViewToggle } from "@/components/shared/usage-insights/InsightsViewToggle";
import { InsightsFreshnessChip } from "@/components/shared/usage-insights/InsightsFreshnessChip";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";

interface InsightsWorkbenchProps {
  /** Which surface's insights to read. Null ⇒ nothing to scope to. */
  scope: InsightsScope | null;
  /** Identity of the cohort; when it changes, filter + selection reset. */
  cohortKey: string;
  /** Force-applied filter transform (e.g. User Testing's hide-synthetic). */
  augmentFilter?: (filter: UsageFilterState) => UsageFilterState;
  /** Selection restored from the `sel` URL parameter. */
  urlSelection?: ReadonlyArray<Pick<ThemeRef, "dimension" | "clusterId">> | null;
  /** Persist flow selection changes in the owning route. */
  onSelectionChange?: (
    themes: ReadonlyArray<Pick<ThemeRef, "dimension" | "clusterId">> | null,
  ) => void;
  initialView?: InsightsView;
  onViewChange?: (view: InsightsView) => void;
  /** Open a session in the Sessions browser (the parent owns the tab flip). */
  onOpenSession?: (sessionId: string) => void;
  /** Open the Sessions tab without selecting a particular session. */
  onOpenSessionsTab?: () => void;
  /** Leading statline content supplied by the owning page. */
  personasSlot?: ReactNode;
  /**
   * Pattern / findings chips supplied by the owning page. A function receives
   * the breakdown this workbench is already subscribed to: User Testing's
   * Feedback popover renders FROM the breakdown and must not appear when there
   * is nothing rated to show, and the workbench owns that subscription — a
   * plain node would force the page to duplicate the query to decide.
   */
  strugglesSlot?:
    | ReactNode
    | ((breakdown: UsageBreakdown | null | undefined) => ReactNode);
  /** Extra content shown below the rubric scorecard in its popover. */
  checksExtras?: ReactNode;
  /**
   * Queue one rebuild when the Clusters view opens on a completed run whose
   * topic map was never built. The server mutation dedupes in-flight runs; the
   * ref below is hygiene before Convex reflects the queued state.
   */
  autoBackfillTopicMap?: boolean;
  /**
   * Rendered instead of the body when there is nothing to show — either no
   * scope to read (a signed-out swarm) or a cohort with zero sessions. The
   * copy is the caller's, because why there is nothing is a property of the
   * surface: Swarms want "sign in", User Testing wants "share the link".
   */
  emptyState?: ReactNode;
  className?: string;
  /**
   * Prefix for every `data-testid` this renders, so each surface keeps the
   * ids its own suites already assert (`swarm-insights-*`, `chatbox-insights-*`).
   */
  testIdPrefix: string;
}

/**
 * The Insights workbench: one body for Swarms and User Testing.
 *
 * Exclusive toggle between Session flow (Sankey) and Clusters (topic map),
 * a statline above both, a chip row for dismissible filters, and a session
 * drill-down beside the flow chart. Everything surface-specific arrives as a
 * prop — the scope the queries read, the slots the statline renders, the
 * filter policy, the empty state, and the testid prefix.
 *
 * This replaces two panels that had drifted into ~250 lines of duplicated
 * shell against the same hooks. Where the two disagreed, the reconciliations
 * are deliberate:
 *
 *  - The drill-down is ALWAYS MOUNTED and hidden when closed (the User Testing
 *    contract, pinned by its flow-selection suite): closing toggles the
 *    query's `enabled` rather than unmounting the component, so reopening does
 *    not refetch from scratch. Swarm adopts it.
 *  - The drill-down receives `flow.effectiveFilter`, not `flow.filter`, so a
 *    force-applied chip (hide-synthetic) narrows the drill-down too. Swarm's
 *    version passed the raw filter, which on a surface with an augment would
 *    have shown rows the list beside it excludes.
 *  - Only the fill-viewport layout survives. The scroll-area path had no
 *    production caller, and with it goes the panel-level criterion scorecard —
 *    the statline already renders that scorecard in a popover.
 *  - A topic-map dot click clears the filter on BOTH surfaces before opening
 *    the session: an active cluster chip can otherwise hide the very session
 *    the click asked for.
 */
export function InsightsWorkbench({
  scope,
  cohortKey,
  augmentFilter,
  urlSelection,
  onSelectionChange,
  initialView,
  onViewChange,
  onOpenSession,
  onOpenSessionsTab,
  personasSlot,
  strugglesSlot,
  checksExtras,
  autoBackfillTopicMap = false,
  emptyState,
  className,
  testIdPrefix,
}: InsightsWorkbenchProps) {
  const flow = useInsightsFlowController({
    cohortKey,
    ...(augmentFilter ? { augmentFilter } : {}),
    ...(onSelectionChange ? { onSelectionChange } : {}),
    ...(initialView ? { initialView } : {}),
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

  const { setView } = flow;
  const handleViewChange = useCallback(
    (next: InsightsView) => {
      setView(next);
      onViewChange?.(next);
    },
    [setView, onViewChange],
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- identity via key
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

  // One-shot topic-map backfill per cohort.
  const topicMapBackfillKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!autoBackfillTopicMap) return;
    if (flow.view !== "clusters") return;
    const latestRun = breakdown?.latestRun;
    if (!latestRun) return;
    if (latestRun.status !== "done" || latestRun.topicMapReady) return;
    if (topicMapBackfillKeyRef.current === cohortKey) return;
    topicMapBackfillKeyRef.current = cohortKey;
    void rebuild().catch(() => {
      // Leave the panel's failed/empty CTA to surface retry; avoid toast noise.
      topicMapBackfillKeyRef.current = null;
    });
  }, [
    autoBackfillTopicMap,
    flow.view,
    cohortKey,
    breakdown?.latestRun,
    rebuild,
  ]);

  // Topic-map dot click → open that session. Clear the filter first so an
  // active cluster chip can't hide the very session the click asked for.
  const { clearAllFilters } = flow;
  const handleOpenSessionFromMap = useCallback(
    (sessionId: string) => {
      clearAllFilters();
      onOpenSession?.(sessionId);
    },
    [clearAllFilters, onOpenSession],
  );

  // Absent is not zero. `undefined` breakdown is loading — an empty state
  // shown during the first subscription would flash on every mount — and a
  // breakdown whose `totalSessions` is missing is a backend that does not
  // report it, not a cohort with no sessions.
  //
  // FILTERED-TO-ZERO IS NOT EMPTY. Two criteria that never co-occur intersect
  // to nothing, and swapping the whole workbench for "no sessions here" would
  // take the chip row away with it — leaving the user no way to undo the
  // filter that emptied the view. Only an UNFILTERED zero is the cohort being
  // empty; the forced policy chip (hide-synthetic) is not a user filter and is
  // not dismissible, so it is correctly absent from this test.
  const userFiltered =
    flow.dismissibleChips.length > 0 || flow.flowSelection !== null;
  const nothingToShow =
    scope === null || (!userFiltered && breakdown?.totalSessions === 0);
  if (emptyState && nothingToShow) {
    return (
      <div
        className={cn("flex h-full min-h-0 flex-col", className)}
        data-testid={`${testIdPrefix}-panel`}
      >
        {emptyState}
      </div>
    );
  }
  // No scope and no empty state to show for it: render nothing rather than a
  // body wired to a cohort that does not exist.
  if (!scope) return null;

  const journeyRunIds =
    scope.kind === "swarm" && scope.journeyRunIds?.length
      ? scope.journeyRunIds
      : undefined;

  const viewToggle = (
    <InsightsViewToggle
      view={flow.view}
      onChange={handleViewChange}
      testId={`${testIdPrefix}-view-toggle`}
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
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-hidden">
        <SessionFlowSankey
          breakdown={breakdown}
          selection={flow.flowSelection}
          onSelectNode={flow.handleSelectFlow}
          onSelectLink={flow.handleSelectFlow}
          onRebuild={handleRebuild}
          rebuildBusy={rebuildBusy}
          onApplyTuning={handleApplyTuning}
          showLinkThreshold
          fillHeight
        />
      </div>
      {chipRow}
    </div>
  );

  const clustersBlock = (
    <div className="flex h-full min-h-0 flex-col">
      {chipRow}
      <div className="min-h-0 flex-1">
        <TopicMapPanel
          scope={scope}
          {...(journeyRunIds ? { journeyRunIds } : {})}
          filter={flow.filter}
          onToggleChip={flow.handleToggleChip}
          onClearChip={flow.handleClearChip}
          onRebuild={handleRebuild}
          rebuildBusy={rebuildBusy}
          onOpenSession={handleOpenSessionFromMap}
        />
      </div>
    </div>
  );

  const selectionOpen = flow.flowSelection !== null;

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col gap-2 overflow-hidden",
        className,
      )}
      data-testid={`${testIdPrefix}-panel`}
    >
      <InsightsStatline
        breakdown={breakdown}
        filter={flow.filter}
        flowSelection={flow.flowSelection}
        onSelectFlow={flow.handleSelectFlow}
        onToggleChip={flow.handleToggleChip}
        onOpenSessionsTab={onOpenSessionsTab}
        leadingSlot={personasSlot}
        strugglesSlot={
          typeof strugglesSlot === "function"
            ? strugglesSlot(breakdown)
            : strugglesSlot
        }
        checksExtras={checksExtras}
        trailing={
          <>
            {/* The chip reads `getWindowSignals` for its staleness watermark,
                and that query ships with the backend PR — `useQuery` against an
                undeployed function THROWS, which without this boundary would
                take the whole Insights tab down rather than one chip. Same
                reason the findings rail is wrapped at its mount.
                Keyed on the cohort so a boundary tripped against the
                undeployed backend re-arms on the next scenario the user
                opens, rather than staying latched for the life of the mount;
                a tab left open on ONE cohort across the deploy still needs a
                navigation to pick the chip up. */}
            <ErrorBoundary key={cohortKey} fallback={null}>
              <InsightsFreshnessChip
                scope={scope}
                latestRun={breakdown?.latestRun}
                onRebuild={handleRebuild}
                rebuildBusy={rebuildBusy}
                testId={`${testIdPrefix}-freshness-chip`}
              />
            </ErrorBoundary>
            {viewToggle}
          </>
        }
        testId={`${testIdPrefix}-statline`}
      />
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {flow.view === "clusters" ? clustersBlock : sankeyBlock}
        </div>
        {flow.view === "flow" ? (
          <div
            className={cn(
              selectionOpen
                ? "absolute inset-0 z-10 bg-background sm:static sm:w-[22rem] lg:w-[24rem] sm:shrink-0 sm:border-l sm:border-border/40"
                : "hidden",
            )}
            data-testid={`${testIdPrefix}-drill-panel`}
            aria-hidden={!selectionOpen}
          >
            {/* Always mounted (hidden when closed) so close toggles
                `enabled: false` instead of unmounting — the flow-selection
                tests pin that contract. */}
            <GoalOutcomeDrilldown
              scope={scope}
              selection={flow.flowSelection}
              filter={flow.effectiveFilter}
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
