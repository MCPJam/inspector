import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
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
  type ThemeRef,
  type UsageFilterChip,
  type UsageFilterState,
} from "@/hooks/scenario-usage-filters";
import type { RebuildResult, UsageBreakdown } from "@/hooks/useUsageInsights";
import { rebuildFeedback } from "@/components/shared/usage-insights/rebuild-feedback";
import type { ClusterTuning } from "@/lib/cluster-tuning";

export type InsightsView = "flow" | "clusters";

type RebuildFn = (args?: {
  tuning?: ClusterTuning;
  force?: boolean;
}) => Promise<RebuildResult>;

/**
 * Shared Session-flow / Clusters orchestration for User Testing and Swarm
 * Insights: filter ownership, breakdown subtraction, and the exclusive view
 * toggle.
 *
 * Call this BEFORE `useUsageInsights` (it only needs the cohort key). Wire
 * rebuild toasts through {@link useInsightsRebuild} after the insights hook
 * returns. URL selection sync (`?sel=`) stays in the Swarm shell — it needs
 * the Sankey breakdown to enrich labels.
 *
 * Surfaces stay responsible for scope, chrome (statline / calibration), and
 * layout.
 */
export function useInsightsFlowController({
  cohortKey,
  augmentFilter,
  onSelectionChange,
  onCohortReset,
  initialView = "flow",
}: {
  /** Identity of the cohort; when it changes, filter + selection reset. */
  cohortKey: string;
  /**
   * Optional transform applied before breakdown subtraction (e.g. force-hide
   * synthetic sessions on scenarios). The raw `filter` stays what the UI edits.
   */
  augmentFilter?: (filter: UsageFilterState) => UsageFilterState;
  onSelectionChange?: (
    themes: ReadonlyArray<Pick<ThemeRef, "dimension" | "clusterId">> | null,
  ) => void;
  onCohortReset?: () => void;
  initialView?: InsightsView;
}) {
  const [view, setView] = useState<InsightsView>(initialView);
  const [filter, setFilter] = useState<UsageFilterState>(EMPTY_USAGE_FILTER);
  const [flowSelection, setFlowSelection] = useState<InsightsSelection | null>(
    null,
  );
  // The chips the flow actually ADDED — ownership, not implication — so
  // teardown never deletes a chip another writer (topic map, strip) put there.
  const [flowOwnedKeys, setFlowOwnedKeys] = useState<string[]>([]);
  const flowSelectionRef = useRef<InsightsSelection | null>(null);
  const filterRef = useRef<UsageFilterState>(EMPTY_USAGE_FILTER);
  const flowOwnedKeysRef = useRef<string[]>([]);
  flowSelectionRef.current = flowSelection;
  filterRef.current = filter;
  flowOwnedKeysRef.current = flowOwnedKeys;

  const prevCohortKeyRef = useRef(cohortKey);
  useEffect(() => {
    if (prevCohortKeyRef.current === cohortKey) return;
    prevCohortKeyRef.current = cohortKey;
    setFilter(EMPTY_USAGE_FILTER);
    setFlowSelection(null);
    setFlowOwnedKeys([]);
    setView(initialView);
    onCohortReset?.();
    onSelectionChange?.(null);
  }, [cohortKey, initialView, onCohortReset, onSelectionChange]);

  const effectiveFilter = useMemo(
    () => (augmentFilter ? augmentFilter(filter) : filter),
    [filter, augmentFilter],
  );

  // Selection chips must not reach the breakdown query — they are the
  // diagram's own output, and feeding them back collapses the diagram.
  const breakdownFilter = useMemo(
    () => removeChipsByKeys(effectiveFilter, flowOwnedKeys),
    [effectiveFilter, flowOwnedKeys],
  );

  const commitSelection = useCallback(
    (next: InsightsSelection | null, opts?: { silent?: boolean }) => {
      const currentFlowSelection = flowSelectionRef.current;
      const currentFilter = filterRef.current;
      const currentOwnedKeys = flowOwnedKeysRef.current;
      if (next === null) {
        setFilter((prev) => removeChipsByKeys(prev, currentOwnedKeys));
        setFlowSelection(null);
        setFlowOwnedKeys([]);
        if (!opts?.silent) onSelectionChange?.(null);
        return;
      }
      const isAlreadyOpen = isSameSelection(currentFlowSelection, next);
      const cleared = removeChipsByKeys(currentFilter, currentOwnedKeys);
      if (isAlreadyOpen) {
        setFilter(cleared);
        setFlowSelection(null);
        setFlowOwnedKeys([]);
        if (!opts?.silent) onSelectionChange?.(null);
        return;
      }
      const added = selectionChipsToAdd(cleared, next);
      setFilter({ ...cleared, chips: [...cleared.chips, ...added] });
      setFlowSelection(next);
      setFlowOwnedKeys(added.map(chipKey));
      if (!opts?.silent) onSelectionChange?.(next.themes);
    },
    [onSelectionChange],
  );

  const handleSelectFlow = useCallback(
    (next: InsightsSelection) => commitSelection(next),
    [commitSelection],
  );

  const handleCloseFlow = useCallback(
    () => commitSelection(null),
    [commitSelection],
  );

  const handleToggleChip = useCallback(
    (chip: UsageFilterChip) => setFilter((prev) => toggleChip(prev, chip)),
    [],
  );

  const handleClearChip = useCallback(
    (key: string) => setFilter((prev) => removeChipByKey(prev, key)),
    [],
  );

  const clearAllFilters = useCallback(() => {
    setFilter(EMPTY_USAGE_FILTER);
    setFlowSelection(null);
    setFlowOwnedKeys([]);
  }, []);

  // Dismissible pills exclude flow-owned chips — those are already expressed
  // by the selected path in the diagram.
  const dismissibleChips = useMemo(() => {
    const owned = new Set(flowOwnedKeys);
    return filter.chips.filter((chip) => !owned.has(chipKey(chip)));
  }, [filter.chips, flowOwnedKeys]);

  useEffect(() => {
    if (!flowSelection) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        commitSelection(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [flowSelection, commitSelection]);

  return {
    view,
    setView,
    filter,
    setFilter,
    effectiveFilter,
    breakdownFilter,
    flowSelection,
    /** Refresh labels without toggling open/closed (URL restore after Sankey loads). */
    setFlowSelection,
    flowSelectionRef,
    flowOwnedKeys,
    dismissibleChips,
    commitSelection,
    handleSelectFlow,
    handleCloseFlow,
    handleToggleChip,
    handleClearChip,
    clearAllFilters,
  };
}

/**
 * Rebuild latch + toast feedback. Pair with {@link useInsightsFlowController}:
 * pass the same `cohortKey` so a cohort switch invalidates in-flight work.
 */
export function useInsightsRebuild(rebuild: RebuildFn, cohortKey: string) {
  const [rebuildBusy, setRebuildBusy] = useState(false);
  const rebuildInFlightRef = useRef(false);
  const rebuildNonceRef = useRef(0);

  // Cohort change: drop the latch so a previous scenario/wave's promise cannot
  // keep this one's button disabled.
  useEffect(() => {
    rebuildNonceRef.current += 1;
    rebuildInFlightRef.current = false;
    setRebuildBusy(false);
  }, [cohortKey]);

  const handleRebuild = useCallback(
    async (args?: { tuning?: ClusterTuning; force?: boolean }) => {
      if (rebuildInFlightRef.current) return;
      rebuildNonceRef.current += 1;
      const myNonce = rebuildNonceRef.current;
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
        if (rebuildNonceRef.current === myNonce) {
          rebuildInFlightRef.current = false;
          setRebuildBusy(false);
        }
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

  return { rebuildBusy, handleRebuild, handleApplyTuning };
}

/**
 * Start the first analysis of a cohort that has sessions and has never been
 * analyzed, so no surface presents "analyze this" as a required first step
 * (BB-196).
 *
 * ONE SHOT PER COHORT, and only from a standing start: it fires when there is
 * NO analysis at all and never to refresh one that exists. Staleness is the
 * backend's to judge — its idle rebuild runs on a clock that knows when a
 * session's outcome became assertable, which a mount cannot know. Same
 * discipline as the workbench's topic-map backfill.
 *
 * Racing is fine and expected. The scenario's own backend fast path queues the
 * same analysis minutes after its testers stop, and two tabs may mount at
 * once; the rebuild mutation's in-flight guard coalesces all of them into a
 * single job. The ref is hygiene for the window before Convex reflects the
 * queued run.
 *
 * Deliberately NOT routed through {@link useInsightsRebuild}: that hook toasts
 * the result, and nobody asked for this one — a toast would report an outcome
 * for an action the user did not take. Failures release the ref so a later
 * breakdown update can try again, and the panel's own copy is what tells the
 * user where the analysis stands.
 *
 * Shared rather than inlined in the workbench so a second User Testing surface
 * — the Findings tab — can adopt the same rule with one call.
 */
export function useEnsureFirstAnalysis({
  enabled,
  cohortKey,
  breakdown,
  rebuild,
}: {
  /** False on surfaces whose analysis must stay explicitly requested. */
  enabled: boolean;
  /** Identity of the cohort; the one-shot latch is per cohort. */
  cohortKey: string;
  breakdown: UsageBreakdown | null | undefined;
  rebuild: RebuildFn;
}) {
  const startedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    // `undefined` is the first subscription, not an answer. Acting on it would
    // queue an analysis for every cohort the user merely passes through.
    if (!breakdown) return;
    // Absent is not zero — a backend that does not report the count is not a
    // cohort with no sessions. Only an explicit zero means there is nothing
    // here to analyze.
    if (breakdown.totalSessions === 0) return;
    if (breakdown.latestRun) return;
    if (startedKeyRef.current === cohortKey) return;
    startedKeyRef.current = cohortKey;
    void rebuild().catch(() => {
      startedKeyRef.current = null;
    });
  }, [enabled, breakdown, cohortKey, rebuild]);
}
