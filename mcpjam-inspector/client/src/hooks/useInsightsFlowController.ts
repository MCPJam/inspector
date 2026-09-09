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
 * One attempt per cohort, and only from a standing start — never to refresh an
 * analysis that exists. Staleness is the backend's to judge, on a clock that
 * knows when a session's outcome became assertable; a mount knows nothing
 * about that.
 *
 * Racing is fine: the backend fast path queues the same analysis minutes after
 * the testers stop, and the rebuild mutation's in-flight guard coalesces that,
 * this, and any other tab into a single job.
 *
 * Returns `failed` when the start was REFUSED, which the caller must use to
 * stop promising that the surface analyzes itself — otherwise `latestRun`
 * stays null forever while the diagram says "Analyzing sessions" and hides the
 * manual rebuild. Not a rare path: `rebuildScenarioInsights` authenticates, so
 * a signed-out guest on a shared scenario link is refused every time, and
 * guests do reach this surface.
 *
 * A refused cohort is therefore never retried — handing the button back is the
 * recovery, and it reports its own outcome because the manual path toasts. Note
 * this is the OPPOSITE policy to the topic-map backfill in `InsightsWorkbench`,
 * which releases its latch and is gated on an opt-in prop. That one retries a
 * cheap map rebuild on a run that already succeeded; this one starts a paid
 * analysis whose refusals are systemic. Do not align them by reflex.
 *
 * Not routed through {@link useInsightsRebuild}: that hook toasts, and nobody
 * asked for this one.
 */
export function useEnsureFirstAnalysis({
  enabled,
  cohortKey,
  breakdown,
  rebuild,
}: {
  /** False on surfaces whose analysis must stay explicitly requested. */
  enabled: boolean;
  /** Identity of the cohort; attempts and refusals are tracked per cohort. */
  cohortKey: string;
  breakdown: UsageBreakdown | null | undefined;
  rebuild: RebuildFn;
}): { failed: boolean } {
  /**
   * Every cohort attempted, not just the last one. A single key could only
   * remember the most recent cohort, so leaving a refused scenario and coming
   * back passed the guard and re-queued it — silently, while `failed` was
   * still presenting the manual button that says it will not.
   */
  const attemptedKeysRef = useRef<Set<string>>(new Set());
  // State, not a ref: the caller has to re-render to withdraw the promise.
  const [failedKeys, setFailedKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  useEffect(() => {
    if (!enabled) return;
    // `undefined` is the first subscription, not an answer. Acting on it would
    // queue an analysis for every cohort the user merely passes through.
    if (!breakdown) return;
    // Typed `number`, but it crosses an `as any` Convex boundary, so an absent
    // count is reachable at runtime — and absent means unknown, not empty.
    // Only an explicit zero says there is nothing here to analyze.
    if (breakdown.totalSessions === 0) return;
    if (breakdown.latestRun) return;
    if (attemptedKeysRef.current.has(cohortKey)) return;
    attemptedKeysRef.current.add(cohortKey);
    void rebuild().catch((error: unknown) => {
      // Logged, unlike the neighbouring backfill: this starts a paid pass
      // nobody asked for, so a systemic refusal (quota, backend down) must
      // leave a trace somewhere rather than only turning a spinner into a
      // button.
      console.warn(
        `[insights] automatic first analysis refused for ${cohortKey}`,
        error,
      );
      setFailedKeys((prev) => new Set(prev).add(cohortKey));
    });
  }, [enabled, breakdown, cohortKey, rebuild]);

  // Keyed on the cohort rather than reset by an effect, so switching scenarios
  // cannot show one scenario's refusal against another's data for a frame.
  return { failed: failedKeys.has(cohortKey) };
}
